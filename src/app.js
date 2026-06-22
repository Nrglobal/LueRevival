const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const flash = require('connect-flash');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { pool, query, tx } = require('./db/pool');
const { config } = require('./config');
const { renderMessage, pageTitle, safeHttpUrl } = require('./lib/format');

const app = express();
if (config.trustProxy) app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const uploadDir = path.isAbsolute(config.uploadDir) ? config.uploadDir : path.join(process.cwd(), config.uploadDir);
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: config.maxUploadMb * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error('Only image uploads are supported'));
    cb(null, true);
  }
});

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", "data:", "https:"],
      "connect-src": ["'self'"]
    }
  }
}));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(express.json({ limit: '100kb' }));
app.use('/uploads', express.static(uploadDir));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: config.sessionSecret,
  name: 'luerevival.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
}));
app.use(flash());
app.use(rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: true, legacyHeaders: false }));

app.get('/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, app: 'LueRevival', source: 'https://github.com/acjordan2/AlpacaBoards' });
  } catch (error) {
    res.status(503).json({ ok: false, error: error.message });
  }
});

app.use(async (req, res, next) => {
  try {
    const site = await query('SELECT * FROM site_options WHERE id = true');
    res.locals.site = site.rows[0] || { site_name: config.siteName, tagline: config.siteTagline, registration_mode: config.registrationMode, invites_enabled: config.invitesEnabled };
    res.locals.pageTitle = (page) => pageTitle(res.locals.site.site_name, page);
    res.locals.flash = { info: req.flash('info'), error: req.flash('error') };
    res.locals.currentUser = null;
    res.locals.renderMessage = renderMessage;
    if (req.session.userId) {
      const user = await query(`SELECT u.*, sp.title AS staff_title, sp.permissions, sp.title_color FROM users u LEFT JOIN staff_positions sp ON sp.id = u.staff_position_id WHERE u.id = $1`, [req.session.userId]);
      if (user.rows[0] && user.rows[0].status !== 'banned') {
        res.locals.currentUser = user.rows[0];
        await query('UPDATE users SET last_active = now() WHERE id = $1', [req.session.userId]);
      } else {
        req.session.destroy(() => {});
      }
    }
    next();
  } catch (error) {
    next(error);
  }
});

app.use((req, res, next) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const submitted = req.body?._csrf || req.query?._csrf || req.headers['x-csrf-token'];
    const expected = req.session.csrfToken;
    const valid = typeof submitted === 'string' && submitted.length === expected.length && crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(expected));
    if (!valid) {
      const err = new Error('Security token expired or invalid. Go back and retry.');
      err.status = 403;
      return next(err);
    }
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
});

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
function isAdmin(user) { return !!user && (user.access_level >= 50 || user.staff_position_id); }
function requireAuth(req, res, next) {
  if (!res.locals.currentUser) {
    req.flash('error', 'Login required.');
    return res.redirect('/login');
  }
  if (res.locals.currentUser.status === 'suspended') {
    req.flash('error', 'Your account is suspended. Posting/admin actions are disabled.');
    return res.redirect('/');
  }
  next();
}
function requireAdmin(req, res, next) {
  if (!isAdmin(res.locals.currentUser)) {
    req.flash('error', 'Administrator access required.');
    return res.redirect('/');
  }
  next();
}
async function audit(actorId, action, entityType, entityId, details = {}) {
  await query('INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details) VALUES ($1,$2,$3,$4,$5)', [actorId || null, action, entityType, entityId || null, details]);
}
function inviteCode() { return crypto.randomBytes(18).toString('base64url'); }
function normalizeTags(tags) { return String(tags || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 12); }
async function applyTags(client, dataId, type, tags, userId) {
  const cleaned = normalizeTags(tags);
  await client.query('DELETE FROM tagged WHERE data_id = $1 AND type = $2', [dataId, type]);
  for (const title of cleaned) {
    const tag = await client.query(`INSERT INTO topical_tags (title, description, user_id) VALUES ($1, '', $2) ON CONFLICT (title) DO UPDATE SET title = EXCLUDED.title RETURNING id`, [title, userId]);
    await client.query('INSERT INTO tagged (data_id, tag_id, type) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [dataId, tag.rows[0].id, type]);
  }
}

app.get('/', asyncHandler(async (_req, res) => {
  if (!res.locals.currentUser) {
    const links = await query(`SELECT id, title, url FROM links WHERE active=true ORDER BY created_at DESC LIMIT 25`);
    const fallback = [
      ['upi.com', 'Sweden rules that in fact file-sharing is NOT an act of religious worship.'],
      ['10tv.com', 'Drunk Ohio Teacher Resists Arrest, Sprays Cops With Her Breastmilk'],
      ['boston.com', 'A Gallery of 47 Photos of the wildest weather from the past year'],
      ['latimes.com', 'San Francisco to vote on banning the sale of all pets (including fish)'],
      ['thesun.co.uk', "World's first bionic-legged dog"],
      ['sciencenews.org', 'Multicellular Life Arises In Test Tube'],
      ['somuchtotellyou.co.nz', 'These are the 100 most beautiful words in the English language, apparently.'],
      ['gizmodo.com', 'Scientists Create Memory Expansion for Brain a la The Matrix']
    ];
    const articles = links.rows.length
      ? links.rows.map(l => {
          let source = 'local';
          try { source = new URL(l.url || 'https://example.com').hostname.replace(/^www\./, ''); } catch (_error) { source = 'local'; }
          return { source, title: l.title, href: l.url || `/links/${l.id}` };
        })
      : fallback.map(([source, title]) => ({ source, title, href: '/login' }));
    return res.render('landing', { articles });
  }

  const boards = await query(`
    SELECT b.* FROM boards b ORDER BY b.sort_order, b.id LIMIT 6
  `);
  const sections = [];
  for (const board of boards.rows) {
    const topics = await query(`
      SELECT t.id, t.title, t.updated_at, t.locked, t.pinned_until, u.username,
        (SELECT count(*)::int FROM messages m WHERE m.topic_id=t.id AND m.deleted=false) AS msgs
      FROM topics t JOIN users u ON u.id = t.user_id
      WHERE t.board_id=$1 AND t.deleted=false
      ORDER BY (t.pinned_until IS NOT NULL AND t.pinned_until > now()) DESC, t.updated_at DESC
      LIMIT 25
    `, [board.id]);
    if (topics.rows.length) sections.push({ title: board.title, board_id: board.id, topics: topics.rows });
  }
  const activeTags = await query(`
    SELECT tt.id, tt.title, count(tg.id)::int AS uses
    FROM topical_tags tt LEFT JOIN tagged tg ON tg.tag_id=tt.id
    GROUP BY tt.id
    ORDER BY uses DESC, tt.title
    LIMIT 60
  `);
  res.render('front', { sections, activeTags: activeTags.rows });
}));

app.get('/source', (_req, res) => res.render('source'));

app.get('/login', (req, res) => res.render('login'));
app.post('/login', asyncHandler(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = await query('SELECT * FROM users WHERE lower(username) = lower($1)', [username]);
  if (!user.rows[0] || !(await bcrypt.compare(password, user.rows[0].password_hash))) {
    req.flash('error', 'Invalid username or password.');
    return res.redirect('/login');
  }
  if (user.rows[0].status === 'banned') {
    req.flash('error', 'This account is banned.');
    return res.redirect('/login');
  }
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.userId = user.rows[0].id;
    req.flash('info', 'Logged in.');
    res.redirect('/');
  });
}));
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

app.get('/register', asyncHandler(async (req, res) => {
  res.render('register', { invite: req.query.invite || '' });
}));
app.post('/register', asyncHandler(async (req, res) => {
  const site = res.locals.site;
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim();
  const password = String(req.body.password || '');
  const invite = String(req.body.invite || '').trim();
  if (!/^[A-Za-z0-9_.-]{3,45}$/.test(username)) throw new Error('Username must be 3-45 chars: letters, numbers, _ . -');
  if (password.length < 12) throw new Error('Password must be at least 12 characters.');
  if (site.registration_mode === 'closed') throw new Error('Registration is closed.');
  await tx(async (client) => {
    let inviteRow = null;
    if (site.registration_mode === 'invite') {
      const found = await client.query('SELECT * FROM invite_tree WHERE invite_code = $1 AND used_at IS NULL FOR UPDATE', [invite]);
      inviteRow = found.rows[0];
      if (!inviteRow) throw new Error('A valid invite code is required.');
    }
    const hash = await bcrypt.hash(password, 12);
    const user = await client.query(`INSERT INTO users (username, email, password_hash, status) VALUES ($1,$2,$3,'active') RETURNING id`, [username, email, hash]);
    if (inviteRow) {
      await client.query('UPDATE invite_tree SET invited_user = $1, used_at = now() WHERE id = $2', [user.rows[0].id, inviteRow.id]);
    }
    await client.query('INSERT INTO audit_log (actor_id, action, entity_type, entity_id, details) VALUES ($1,$2,$3,$4,$5)', [user.rows[0].id, 'register', 'user', user.rows[0].id, { invite: !!inviteRow }]);
  });
  req.flash('info', 'Registered. Log in and post like it is 2014 again.');
  res.redirect('/login');
}));

app.get('/u/:username', asyncHandler(async (req, res) => {
  const user = await query(`
    SELECT u.id, u.username, u.email, u.show_email, u.instant_messaging, u.avatar_url, u.signature, u.quote, u.timezone,
      u.karma, u.good_tokens, u.bad_tokens, u.account_created, u.last_active, u.status, sp.title AS staff_title
    FROM users u LEFT JOIN staff_positions sp ON sp.id=u.staff_position_id
    WHERE lower(u.username)=lower($1)
  `, [req.params.username]);
  if (!user.rows[0]) return res.status(404).render('error', { message: 'User not found' });
  const profile = user.rows[0];
  const cu = res.locals.currentUser;
  const canSeeEmail = profile.show_email || (cu && (cu.id === profile.id || cu.access_level >= 50));
  if (!canSeeEmail) profile.email = null;
  const topics = await query('SELECT id, title, updated_at FROM topics WHERE user_id=$1 AND deleted=false ORDER BY updated_at DESC LIMIT 10', [profile.id]);
  const tagRows = await query(`SELECT id,title,moderators,administrators FROM topical_tags ORDER BY title`);
  const usernameKey = profile.username.toLowerCase();
  const names = (value) => String(value || '').split(/[;,]/).map(v => v.trim().toLowerCase()).filter(Boolean);
  const adminTags = tagRows.rows.filter(t => names(t.administrators).includes(usernameKey));
  const modTags = tagRows.rows.filter(t => names(t.moderators).includes(usernameKey));
  res.render('profile', { profile, topics: topics.rows, adminTags, modTags });
}));
app.post('/u/:username/token', requireAuth, asyncHandler(async (req, res) => {
  const kind = req.body.kind === 'bad' ? 'bad' : 'good';
  const column = kind === 'bad' ? 'bad_tokens' : 'good_tokens';
  const found = await query(`UPDATE users SET ${column}=${column}+1 WHERE lower(username)=lower($1) RETURNING id, username`, [req.params.username]);
  if (!found.rows[0]) return res.status(404).render('error', { message: 'User not found' });
  await audit(res.locals.currentUser.id, `token.${kind}`, 'user', found.rows[0].id);
  req.flash('info', `Gave ${found.rows[0].username} a ${kind} token.`);
  res.redirect(`/u/${encodeURIComponent(found.rows[0].username)}`);
}));
app.get('/settings/profile', requireAuth, (req, res) => res.render('profile_edit'));
app.post('/settings/profile', requireAuth, asyncHandler(async (req, res) => {
  const avatarUrl = req.body.avatar_url ? safeHttpUrl(req.body.avatar_url) : null;
  await query(`UPDATE users SET email=$1, private_email=$2, instant_messaging=$3, avatar_url=$4, signature=$5, quote=$6, timezone=$7, show_email=$8 WHERE id=$9`, [req.body.email || null, req.body.private_email || null, req.body.instant_messaging || null, avatarUrl, req.body.signature || null, req.body.quote || null, req.body.timezone || 'UTC', !!req.body.show_email, res.locals.currentUser.id]);
  await audit(res.locals.currentUser.id, 'profile.update', 'user', res.locals.currentUser.id);
  req.flash('info', 'Profile updated.');
  res.redirect(`/u/${encodeURIComponent(res.locals.currentUser.username)}`);
}));

app.get('/boards/:id', asyncHandler(async (req, res) => {
  const board = await query('SELECT * FROM boards WHERE id=$1', [req.params.id]);
  if (!board.rows[0]) return res.status(404).render('error', { message: 'Board not found' });
  const topics = await query(`
    SELECT t.*, u.username,
      (SELECT count(*)::int FROM messages m WHERE m.topic_id=t.id AND m.deleted=false) AS replies,
      array_remove(array_agg(tag.title ORDER BY tag.title), NULL) AS tags
    FROM topics t
    JOIN users u ON u.id=t.user_id
    LEFT JOIN tagged tg ON tg.data_id=t.id AND tg.type='topic'
    LEFT JOIN topical_tags tag ON tag.id=tg.tag_id
    WHERE t.board_id=$1 AND t.deleted=false
    GROUP BY t.id, u.username
    ORDER BY (t.pinned_until IS NOT NULL AND t.pinned_until > now()) DESC, t.updated_at DESC
    LIMIT 200
  `, [req.params.id]);
  res.render('board', { board: board.rows[0], topics: topics.rows });
}));
app.get('/boards/:id/new', requireAuth, asyncHandler(async (req, res) => {
  const board = await query('SELECT * FROM boards WHERE id=$1', [req.params.id]);
  if (!board.rows[0]) return res.status(404).render('error', { message: 'Board not found' });
  res.render('topic_new', { board: board.rows[0] });
}));
app.post('/boards/:id/topics', requireAuth, asyncHandler(async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 80);
  const body = String(req.body.body || '').trim();
  if (!title || !body) throw new Error('Title and body are required.');
  const topicId = await tx(async (client) => {
    const topic = await client.query('INSERT INTO topics (board_id,user_id,title) VALUES ($1,$2,$3) RETURNING id', [req.params.id, res.locals.currentUser.id, title]);
    await client.query('INSERT INTO messages (topic_id,user_id,body) VALUES ($1,$2,$3)', [topic.rows[0].id, res.locals.currentUser.id, body]);
    await applyTags(client, topic.rows[0].id, 'topic', req.body.tags, res.locals.currentUser.id);
    await client.query('UPDATE users SET karma = karma + 1 WHERE id=$1', [res.locals.currentUser.id]);
    return topic.rows[0].id;
  });
  await audit(res.locals.currentUser.id, 'topic.create', 'topic', topicId);
  res.redirect(`/topics/${topicId}`);
}));

app.get('/topics/:id', asyncHandler(async (req, res) => {
  const topic = await query(`SELECT t.*, b.title AS board_title, u.username FROM topics t JOIN boards b ON b.id=t.board_id JOIN users u ON u.id=t.user_id WHERE t.id=$1 AND t.deleted=false`, [req.params.id]);
  if (!topic.rows[0]) return res.status(404).render('error', { message: 'Topic not found' });
  const messages = await query(`SELECT m.*, u.username, u.avatar_url, u.signature FROM messages m JOIN users u ON u.id=m.user_id WHERE m.topic_id=$1 ORDER BY m.posted_at, m.id`, [req.params.id]);
  const tags = await query(`SELECT tag.* FROM tagged tg JOIN topical_tags tag ON tag.id=tg.tag_id WHERE tg.type='topic' AND tg.data_id=$1 ORDER BY tag.title`, [req.params.id]);
  if (res.locals.currentUser) {
    await query(`INSERT INTO topic_history (topic_id,user_id,message_id,viewed_at) VALUES ($1,$2,$3,now()) ON CONFLICT(topic_id,user_id) DO UPDATE SET viewed_at=now(), message_id=EXCLUDED.message_id`, [req.params.id, res.locals.currentUser.id, messages.rows.at(-1)?.id || null]);
  }
  res.render('topic', { topic: topic.rows[0], messages: messages.rows, tags: tags.rows, canAdmin: isAdmin(res.locals.currentUser) });
}));
app.post('/topics/:id/reply', requireAuth, asyncHandler(async (req, res) => {
  const topic = await query('SELECT * FROM topics WHERE id=$1 AND deleted=false', [req.params.id]);
  if (!topic.rows[0]) throw new Error('Topic not found.');
  if (topic.rows[0].locked && !isAdmin(res.locals.currentUser)) throw new Error('Topic is locked.');
  const body = String(req.body.body || '').trim();
  if (!body) throw new Error('Reply body is required.');
  await query('INSERT INTO messages (topic_id,user_id,body) VALUES ($1,$2,$3)', [req.params.id, res.locals.currentUser.id, body]);
  await query('UPDATE topics SET updated_at=now() WHERE id=$1', [req.params.id]);
  await query('UPDATE users SET karma = karma + 1 WHERE id=$1', [res.locals.currentUser.id]);
  res.redirect(`/topics/${req.params.id}#bottom`);
}));
app.post('/messages/:id/edit', requireAuth, asyncHandler(async (req, res) => {
  const msg = await query('SELECT * FROM messages WHERE id=$1', [req.params.id]);
  if (!msg.rows[0]) throw new Error('Message not found.');
  if (msg.rows[0].user_id !== res.locals.currentUser.id && !isAdmin(res.locals.currentUser)) throw new Error('Not allowed.');
  const body = String(req.body.body || '').trim();
  await tx(async (client) => {
    await client.query('INSERT INTO message_revisions (message_id, revision_no, body, edited_by) VALUES ($1,$2,$3,$4)', [msg.rows[0].id, msg.rows[0].revision_no, msg.rows[0].body, res.locals.currentUser.id]);
    await client.query('UPDATE messages SET body=$1, revision_no=revision_no+1, edited_at=now() WHERE id=$2', [body, msg.rows[0].id]);
  });
  await audit(res.locals.currentUser.id, 'message.edit', 'message', msg.rows[0].id);
  res.redirect(`/topics/${msg.rows[0].topic_id}#m${msg.rows[0].id}`);
}));
app.post('/messages/:id/delete', requireAuth, asyncHandler(async (req, res) => {
  const msg = await query('SELECT * FROM messages WHERE id=$1', [req.params.id]);
  if (!msg.rows[0]) throw new Error('Message not found.');
  if (msg.rows[0].user_id !== res.locals.currentUser.id && !isAdmin(res.locals.currentUser)) throw new Error('Not allowed.');
  await query('UPDATE messages SET deleted=true WHERE id=$1', [msg.rows[0].id]);
  await audit(res.locals.currentUser.id, 'message.delete', 'message', msg.rows[0].id, { soft: true });
  res.redirect(`/topics/${msg.rows[0].topic_id}`);
}));
app.post('/topics/:id/mod', requireAdmin, asyncHandler(async (req, res) => {
  const action = req.body.action;
  if (action === 'lock') await query('UPDATE topics SET locked=true WHERE id=$1', [req.params.id]);
  if (action === 'unlock') await query('UPDATE topics SET locked=false WHERE id=$1', [req.params.id]);
  if (action === 'delete') await query('UPDATE topics SET deleted=true WHERE id=$1', [req.params.id]);
  if (action === 'pin') await query("UPDATE topics SET pinned_until=now()+interval '24 hours' WHERE id=$1", [req.params.id]);
  await audit(res.locals.currentUser.id, `topic.${action}`, 'topic', req.params.id);
  res.redirect(`/topics/${req.params.id}`);
}));

app.get('/links', asyncHandler(async (_req, res) => {
  const links = await query(`SELECT l.*, u.username, coalesce(sum(v.vote),0)::int AS score FROM links l JOIN users u ON u.id=l.user_id LEFT JOIN link_votes v ON v.link_id=l.id WHERE l.active=true GROUP BY l.id,u.username ORDER BY l.created_at DESC LIMIT 100`);
  res.render('links', { links: links.rows });
}));
app.get('/links/new', requireAuth, (req, res) => res.render('link_new'));
app.post('/links', requireAuth, asyncHandler(async (req, res) => {
  const linkId = await tx(async (client) => {
    const safeUrl = safeHttpUrl(req.body.url);
    const link = await client.query('INSERT INTO links (user_id,title,url,description) VALUES ($1,$2,$3,$4) RETURNING id', [res.locals.currentUser.id, req.body.title, safeUrl, req.body.description]);
    await applyTags(client, link.rows[0].id, 'link', req.body.tags, res.locals.currentUser.id);
    return link.rows[0].id;
  });
  await audit(res.locals.currentUser.id, 'link.create', 'link', linkId);
  res.redirect(`/links/${linkId}`);
}));
app.get('/links/:id', asyncHandler(async (req, res) => {
  const link = await query(`SELECT l.*, u.username, coalesce(sum(v.vote),0)::int AS score FROM links l JOIN users u ON u.id=l.user_id LEFT JOIN link_votes v ON v.link_id=l.id WHERE l.id=$1 GROUP BY l.id,u.username`, [req.params.id]);
  if (!link.rows[0]) return res.status(404).render('error', { message: 'Link not found' });
  const comments = await query('SELECT lm.*, u.username FROM link_messages lm JOIN users u ON u.id=lm.user_id WHERE lm.link_id=$1 ORDER BY lm.posted_at', [req.params.id]);
  const tags = await query(`SELECT tag.* FROM tagged tg JOIN topical_tags tag ON tag.id=tg.tag_id WHERE tg.type='link' AND tg.data_id=$1 ORDER BY tag.title`, [req.params.id]);
  res.render('link', { link: link.rows[0], comments: comments.rows, tags: tags.rows, canAdmin: isAdmin(res.locals.currentUser) });
}));
app.post('/links/:id/comment', requireAuth, asyncHandler(async (req, res) => {
  await query('INSERT INTO link_messages (user_id,link_id,body) VALUES ($1,$2,$3)', [res.locals.currentUser.id, req.params.id, req.body.body]);
  res.redirect(`/links/${req.params.id}`);
}));
app.post('/links/:id/vote', requireAuth, asyncHandler(async (req, res) => {
  const vote = req.body.vote === '-1' ? -1 : 1;
  await query('INSERT INTO link_votes (user_id,link_id,vote) VALUES ($1,$2,$3) ON CONFLICT(user_id,link_id) DO UPDATE SET vote=EXCLUDED.vote, created_at=now()', [res.locals.currentUser.id, req.params.id, vote]);
  res.redirect(`/links/${req.params.id}`);
}));
app.post('/links/:id/favorite', requireAuth, asyncHandler(async (req, res) => {
  await query('INSERT INTO link_favorites (link_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.params.id, res.locals.currentUser.id]);
  res.redirect(`/links/${req.params.id}`);
}));
app.post('/links/:id/report', requireAuth, asyncHandler(async (req, res) => {
  await query('INSERT INTO link_reports (user_id,link_id,reason) VALUES ($1,$2,$3)', [res.locals.currentUser.id, req.params.id, req.body.reason]);
  req.flash('info', 'Report filed for staff review.');
  res.redirect(`/links/${req.params.id}`);
}));

app.get('/search', asyncHandler(async (req, res) => {
  const q = String(req.query.q || '').trim();
  let results = [];
  if (q) {
    const found = await query(`
      SELECT 'topic' AS type, t.id, t.title, left(m.body, 280) AS snippet, ts_rank(to_tsvector('english', t.title || ' ' || coalesce(m.body,'')), plainto_tsquery('english', $1)) AS rank
      FROM topics t LEFT JOIN messages m ON m.topic_id=t.id
      WHERE t.deleted=false AND to_tsvector('english', t.title || ' ' || coalesce(m.body,'')) @@ plainto_tsquery('english', $1)
      UNION ALL
      SELECT 'link' AS type, l.id, l.title, left(l.description, 280) AS snippet, ts_rank(to_tsvector('english', l.title || ' ' || l.description), plainto_tsquery('english', $1)) AS rank
      FROM links l
      WHERE l.active=true AND to_tsvector('english', l.title || ' ' || l.description) @@ plainto_tsquery('english', $1)
      ORDER BY rank DESC LIMIT 50
    `, [q]);
    results = found.rows;
  }
  res.render('search', { q, results });
}));

app.get('/shop', requireAuth, asyncHandler(async (req, res) => {
  const items = await query('SELECT * FROM shop_items WHERE active=true ORDER BY price, id');
  const inventory = await query(`SELECT i.*, st.created_at, si.name, si.description FROM inventory i JOIN shop_transactions st ON st.id=i.transaction_id JOIN shop_items si ON si.id=st.item_id WHERE i.user_id=$1 AND i.consumed_at IS NULL ORDER BY i.id DESC`, [res.locals.currentUser.id]);
  res.render('shop', { items: items.rows, inventory: inventory.rows });
}));
app.post('/shop/buy/:id', requireAuth, asyncHandler(async (req, res) => {
  await tx(async (client) => {
    const item = await client.query('SELECT * FROM shop_items WHERE id=$1 AND active=true FOR UPDATE', [req.params.id]);
    if (!item.rows[0]) throw new Error('Item not found.');
    const user = await client.query('SELECT karma FROM users WHERE id=$1 FOR UPDATE', [res.locals.currentUser.id]);
    if (user.rows[0].karma < item.rows[0].price) throw new Error('Not enough karma.');
    await client.query('UPDATE users SET karma=karma-$1 WHERE id=$2', [item.rows[0].price, res.locals.currentUser.id]);
    const tr = await client.query('INSERT INTO shop_transactions (user_id,item_id,value) VALUES ($1,$2,$3) RETURNING id', [res.locals.currentUser.id, item.rows[0].id, item.rows[0].price]);
    await client.query('INSERT INTO inventory (user_id,transaction_id) VALUES ($1,$2)', [res.locals.currentUser.id, tr.rows[0].id]);
  });
  req.flash('info', 'Item purchased.');
  res.redirect('/shop');
}));

app.get('/invite', requireAuth, asyncHandler(async (req, res) => {
  const invites = await query('SELECT * FROM invite_tree WHERE invited_by=$1 ORDER BY created_at DESC', [res.locals.currentUser.id]);
  const inviteItems = await query(`SELECT i.id AS inventory_id, st.id AS transaction_id FROM inventory i JOIN shop_transactions st ON st.id=i.transaction_id JOIN shop_items si ON si.id=st.item_id WHERE i.user_id=$1 AND i.consumed_at IS NULL AND lower(si.name)='invite'`, [res.locals.currentUser.id]);
  res.render('invite', { invites: invites.rows, inviteItems: inviteItems.rows });
}));
app.post('/invite', requireAuth, asyncHandler(async (req, res) => {
  const code = await tx(async (client) => {
    const inv = await client.query(`SELECT i.id AS inventory_id, st.id AS transaction_id FROM inventory i JOIN shop_transactions st ON st.id=i.transaction_id JOIN shop_items si ON si.id=st.item_id WHERE i.id=$1 AND i.user_id=$2 AND i.consumed_at IS NULL AND lower(si.name)='invite' FOR UPDATE`, [req.body.inventory_id, res.locals.currentUser.id]);
    if (!inv.rows[0]) throw new Error('No invite item available. Buy one in the shop first.');
    const code = inviteCode();
    await client.query('INSERT INTO invite_tree (invited_by, invite_code, email, transaction_id) VALUES ($1,$2,$3,$4)', [res.locals.currentUser.id, code, req.body.email || null, inv.rows[0].transaction_id]);
    await client.query('UPDATE inventory SET consumed_at=now() WHERE id=$1', [inv.rows[0].inventory_id]);
    return code;
  });
  req.flash('info', `Invite generated: ${code}`);
  res.redirect('/invite');
}));

app.get('/images', requireAuth, asyncHandler(async (_req, res) => {
  const images = await query('SELECT ui.*, u.username FROM uploaded_images ui JOIN users u ON u.id=ui.user_id ORDER BY ui.created_at DESC LIMIT 60');
  res.render('images', { images: images.rows });
}));
app.post('/images', requireAuth, upload.single('image'), asyncHandler(async (req, res) => {
  if (!req.file) throw new Error('Image file is required.');
  const bytes = fs.readFileSync(req.file.path);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const storedName = `${sha}${path.extname(req.file.originalname).toLowerCase()}`;
  fs.renameSync(req.file.path, path.join(uploadDir, storedName));
  await query(`INSERT INTO uploaded_images (user_id, sha256_sum, original_name, stored_name, mime_type, byte_size) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(sha256_sum) DO NOTHING`, [res.locals.currentUser.id, sha, req.file.originalname, storedName, req.file.mimetype, req.file.size]);
  req.flash('info', 'Image uploaded.');
  res.redirect('/images');
}));

app.get('/admin', requireAdmin, asyncHandler(async (_req, res) => {
  const stats = await query(`SELECT (SELECT count(*) FROM users)::int users, (SELECT count(*) FROM topics)::int topics, (SELECT count(*) FROM messages)::int messages, (SELECT count(*) FROM links)::int links, (SELECT count(*) FROM link_reports WHERE resolved=false)::int reports`);
  const auditRows = await query('SELECT al.*, u.username FROM audit_log al LEFT JOIN users u ON u.id=al.actor_id ORDER BY al.created_at DESC LIMIT 40');
  res.render('admin', { stats: stats.rows[0], audit: auditRows.rows });
}));
app.get('/admin/users', requireAdmin, asyncHandler(async (_req, res) => {
  const users = await query('SELECT u.*, sp.title AS staff_title FROM users u LEFT JOIN staff_positions sp ON sp.id=u.staff_position_id ORDER BY u.id');
  res.render('admin_users', { users: users.rows });
}));
app.post('/admin/users/:id', requireAdmin, asyncHandler(async (req, res) => {
  const status = ['active','suspended','banned','pending'].includes(req.body.status) ? req.body.status : 'active';
  const access = Math.max(0, Math.min(100, Number(req.body.access_level || 0)));
  await query('UPDATE users SET status=$1, access_level=$2, staff_position_id=$3 WHERE id=$4', [status, access, req.body.staff_position_id || null, req.params.id]);
  await query('INSERT INTO discipline_history (user_id, mod_id, action_taken, description) VALUES ($1,$2,$3,$4)', [req.params.id, res.locals.currentUser.id, `status:${status}`, req.body.description || 'Admin user update']);
  await audit(res.locals.currentUser.id, 'user.update', 'user', req.params.id, { status, access });
  res.redirect('/admin/users');
}));
app.get('/admin/site', requireAdmin, asyncHandler(async (_req, res) => res.render('admin_site')));
app.post('/admin/site', requireAdmin, asyncHandler(async (req, res) => {
  const mode = ['open','invite','closed'].includes(req.body.registration_mode) ? req.body.registration_mode : 'invite';
  await query('UPDATE site_options SET site_name=$1, tagline=$2, registration_mode=$3, invites_enabled=$4, updated_at=now() WHERE id=true', [req.body.site_name, req.body.tagline, mode, req.body.invites_enabled === 'on']);
  await audit(res.locals.currentUser.id, 'site.update', 'site_options', 1);
  req.flash('info', 'Site options updated.');
  res.redirect('/admin/site');
}));
app.get('/admin/boards', requireAdmin, asyncHandler(async (_req, res) => {
  const boards = await query('SELECT * FROM boards ORDER BY sort_order, id');
  res.render('admin_boards', { boards: boards.rows });
}));
app.post('/admin/boards', requireAdmin, asyncHandler(async (req, res) => {
  await query('INSERT INTO boards (title, description, sort_order, private) VALUES ($1,$2,$3,$4) ON CONFLICT(title) DO UPDATE SET description=EXCLUDED.description, sort_order=EXCLUDED.sort_order, private=EXCLUDED.private', [req.body.title, req.body.description || '', Number(req.body.sort_order || 0), req.body.private === 'on']);
  await audit(res.locals.currentUser.id, 'board.upsert', 'board', null, { title: req.body.title });
  res.redirect('/admin/boards');
}));
app.get('/admin/tags', requireAdmin, asyncHandler(async (_req, res) => {
  const tags = await query('SELECT * FROM topical_tags ORDER BY title');
  res.render('admin_tags', { tags: tags.rows });
}));
app.post('/admin/tags', requireAdmin, asyncHandler(async (req, res) => {
  await query(`INSERT INTO topical_tags (title, description, access, participation, permanent, inceptive, special, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(title) DO UPDATE SET description=EXCLUDED.description, access=EXCLUDED.access, participation=EXCLUDED.participation, permanent=EXCLUDED.permanent, inceptive=EXCLUDED.inceptive, special=EXCLUDED.special`, [req.body.title, req.body.description || '', req.body.access || 'public', req.body.participation || 'open', req.body.permanent === 'on', req.body.inceptive === 'on', req.body.special === 'on', res.locals.currentUser.id]);
  await audit(res.locals.currentUser.id, 'tag.upsert', 'tag', null, { title: req.body.title });
  res.redirect('/admin/tags');
}));
app.get('/admin/tags/:id/edit', requireAdmin, asyncHandler(async (req, res) => {
  const tag = await query('SELECT * FROM topical_tags WHERE id=$1', [req.params.id]);
  if (!tag.rows[0]) return res.status(404).render('error', { message: 'Tag not found' });
  res.render('tag_edit', { tag: tag.rows[0] });
}));
app.post('/admin/tags/:id/edit', requireAdmin, asyncHandler(async (req, res) => {
  const access = ['public','private','moderator'].includes(req.body.access) ? req.body.access : 'public';
  const participation = ['open','staff','owner'].includes(req.body.participation) ? req.body.participation : 'open';
  await query(`
    UPDATE topical_tags SET description=$1, access=$2, participation=$3, permanent=$4, inceptive=$5,
      access_users=$6, parent_tags=$7, child_tags=$8, mutually_exclusive_tags=$9, dependent_tags=$10,
      moderators=$11, administrators=$12
    WHERE id=$13
  `, [req.body.description || '', access, participation, req.body.permanent === 'on', req.body.inceptive === 'on', req.body.access_users || '', req.body.parent_tags || '', req.body.child_tags || '', req.body.mutually_exclusive_tags || '', req.body.dependent_tags || '', req.body.moderators || '', req.body.administrators || '', req.params.id]);
  await audit(res.locals.currentUser.id, 'tag.edit', 'tag', req.params.id);
  req.flash('info', 'Tag updated.');
  res.redirect(`/admin/tags/${req.params.id}/edit`);
}));
app.post('/admin/reports/:id/resolve', requireAdmin, asyncHandler(async (req, res) => {
  await query('UPDATE link_reports SET resolved=true WHERE id=$1', [req.params.id]);
  await audit(res.locals.currentUser.id, 'report.resolve', 'link_report', req.params.id);
  res.redirect('/admin');
}));

app.use((req, res) => res.status(404).render('error', { message: 'Page not found' }));
app.use((err, req, res, _next) => {
  console.error(err);
  const message = err.code === 'EBADCSRFTOKEN' ? 'Security token expired. Go back and retry.' : err.message || 'Server error';
  if (req.session) req.flash('error', message);
  res.status(err.status || 500).render('error', { message });
});

module.exports = { app };
