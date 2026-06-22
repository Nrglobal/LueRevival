CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS site_options (
  id boolean PRIMARY KEY DEFAULT true,
  site_name varchar(256) NOT NULL,
  tagline text NOT NULL DEFAULT '',
  registration_mode text NOT NULL DEFAULT 'invite' CHECK (registration_mode IN ('open','invite','closed')),
  invites_enabled boolean NOT NULL DEFAULT true,
  source_repo text NOT NULL DEFAULT 'https://github.com/acjordan2/AlpacaBoards',
  source_commit text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT singleton_site_options CHECK (id)
);

CREATE TABLE IF NOT EXISTS staff_positions (
  id bigserial PRIMARY KEY,
  title varchar(32) NOT NULL UNIQUE,
  title_color varchar(24) NOT NULL DEFAULT 'red',
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS users (
  id bigserial PRIMARY KEY,
  username varchar(45) NOT NULL UNIQUE,
  email varchar(255),
  private_email varchar(255),
  instant_messaging varchar(80),
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','banned','pending')),
  staff_position_id bigint REFERENCES staff_positions(id),
  access_level int NOT NULL DEFAULT 0,
  avatar_url text,
  signature varchar(256),
  quote varchar(256),
  timezone varchar(64) NOT NULL DEFAULT 'UTC',
  karma int NOT NULL DEFAULT 0,
  good_tokens int NOT NULL DEFAULT 0,
  bad_tokens int NOT NULL DEFAULT 0,
  account_created timestamptz NOT NULL DEFAULT now(),
  last_active timestamptz
);

CREATE TABLE IF NOT EXISTS boards (
  id bigserial PRIMARY KEY,
  title varchar(80) NOT NULL UNIQUE,
  description varchar(256) NOT NULL DEFAULT '',
  sort_order int NOT NULL DEFAULT 0,
  private boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS topics (
  id bigserial PRIMARY KEY,
  board_id bigint NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id),
  title varchar(80) NOT NULL,
  locked boolean NOT NULL DEFAULT false,
  deleted boolean NOT NULL DEFAULT false,
  pinned_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id bigserial PRIMARY KEY,
  topic_id bigint NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id),
  link_id bigint,
  revision_no int NOT NULL DEFAULT 1,
  body varchar(8192) NOT NULL,
  deleted boolean NOT NULL DEFAULT false,
  type int NOT NULL DEFAULT 0,
  posted_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  UNIQUE(id, revision_no)
);

CREATE TABLE IF NOT EXISTS message_revisions (
  id bigserial PRIMARY KEY,
  message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  revision_no int NOT NULL,
  body varchar(8192) NOT NULL,
  edited_by bigint REFERENCES users(id),
  edited_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(message_id, revision_no)
);

CREATE TABLE IF NOT EXISTS topic_history (
  topic_id bigint NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id bigint REFERENCES messages(id),
  page int NOT NULL DEFAULT 1,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(topic_id, user_id)
);

CREATE TABLE IF NOT EXISTS topical_tags (
  id bigserial PRIMARY KEY,
  title varchar(128) NOT NULL UNIQUE,
  description varchar(256) NOT NULL DEFAULT '',
  type int NOT NULL DEFAULT 1,
  access text NOT NULL DEFAULT 'public' CHECK (access IN ('public','private','moderator')),
  participation text NOT NULL DEFAULT 'open' CHECK (participation IN ('open','staff','owner')),
  permanent boolean NOT NULL DEFAULT false,
  inceptive boolean NOT NULL DEFAULT false,
  special boolean NOT NULL DEFAULT false,
  access_users text NOT NULL DEFAULT '',
  parent_tags text NOT NULL DEFAULT '',
  child_tags text NOT NULL DEFAULT '',
  mutually_exclusive_tags text NOT NULL DEFAULT '',
  dependent_tags text NOT NULL DEFAULT '',
  moderators text NOT NULL DEFAULT '',
  administrators text NOT NULL DEFAULT '',
  user_id bigint REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tagged (
  id bigserial PRIMARY KEY,
  data_id bigint NOT NULL,
  tag_id bigint NOT NULL REFERENCES topical_tags(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('topic','link','image')),
  UNIQUE(data_id, tag_id, type)
);

CREATE TABLE IF NOT EXISTS links (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  title varchar(80) NOT NULL,
  url varchar(512),
  description text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS link_messages (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  link_id bigint NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  revision_no int NOT NULL DEFAULT 1,
  body varchar(5120) NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz
);

CREATE TABLE IF NOT EXISTS link_votes (
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  link_id bigint NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  vote smallint NOT NULL CHECK (vote IN (-1, 1)),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, link_id)
);

CREATE TABLE IF NOT EXISTS link_favorites (
  link_id bigint NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(link_id, user_id)
);

CREATE TABLE IF NOT EXISTS link_reports (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  link_id bigint NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  reason varchar(1024) NOT NULL,
  resolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invite_tree (
  id bigserial PRIMARY KEY,
  invited_by bigint NOT NULL REFERENCES users(id),
  invited_user bigint REFERENCES users(id),
  invite_code varchar(80) NOT NULL UNIQUE,
  email text,
  transaction_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz
);

CREATE TABLE IF NOT EXISTS item_classes (
  id bigserial PRIMARY KEY,
  type varchar(24) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS shop_items (
  id bigserial PRIMARY KEY,
  name varchar(64) NOT NULL,
  price int NOT NULL CHECK (price >= 0),
  description varchar(256) NOT NULL,
  active boolean NOT NULL DEFAULT true,
  class_id bigint REFERENCES item_classes(id)
);

CREATE TABLE IF NOT EXISTS shop_transactions (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  item_id bigint NOT NULL REFERENCES shop_items(id),
  value int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  transaction_id bigint NOT NULL REFERENCES shop_transactions(id),
  consumed_at timestamptz
);

CREATE TABLE IF NOT EXISTS discipline_history (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  mod_id bigint NOT NULL REFERENCES users(id),
  message_id bigint REFERENCES messages(id),
  action_taken varchar(1024) NOT NULL,
  description varchar(4096) NOT NULL,
  plea_topic bigint REFERENCES topics(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  reversed_at timestamptz,
  reversal_description varchar(4096)
);

CREATE TABLE IF NOT EXISTS uploaded_images (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  sha256_sum varchar(64) NOT NULL UNIQUE,
  original_name varchar(256) NOT NULL,
  stored_name varchar(256) NOT NULL,
  mime_type varchar(128) NOT NULL,
  byte_size int NOT NULL,
  width int,
  height int,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS image_maps (
  id bigserial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id),
  image_id bigint NOT NULL REFERENCES uploaded_images(id) ON DELETE CASCADE,
  topic_id bigint NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  label varchar(128),
  x int,
  y int,
  width int,
  height int,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  actor_id bigint REFERENCES users(id),
  action varchar(80) NOT NULL,
  entity_type varchar(80) NOT NULL,
  entity_id bigint,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS good_tokens int NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS bad_tokens int NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS topical_tags ADD COLUMN IF NOT EXISTS access_users text NOT NULL DEFAULT '';
ALTER TABLE IF EXISTS topical_tags ADD COLUMN IF NOT EXISTS parent_tags text NOT NULL DEFAULT '';
ALTER TABLE IF EXISTS topical_tags ADD COLUMN IF NOT EXISTS child_tags text NOT NULL DEFAULT '';
ALTER TABLE IF EXISTS topical_tags ADD COLUMN IF NOT EXISTS mutually_exclusive_tags text NOT NULL DEFAULT '';
ALTER TABLE IF EXISTS topical_tags ADD COLUMN IF NOT EXISTS dependent_tags text NOT NULL DEFAULT '';
ALTER TABLE IF EXISTS topical_tags ADD COLUMN IF NOT EXISTS moderators text NOT NULL DEFAULT '';
ALTER TABLE IF EXISTS topical_tags ADD COLUMN IF NOT EXISTS administrators text NOT NULL DEFAULT '';
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS show_email boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_topics_board_updated ON topics(board_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_topic_posted ON messages(topic_id, posted_at ASC);
CREATE INDEX IF NOT EXISTS idx_links_created ON links(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_messages_search ON messages USING GIN (to_tsvector('english', body));
CREATE INDEX IF NOT EXISTS idx_topics_search ON topics USING GIN (to_tsvector('english', title));
CREATE INDEX IF NOT EXISTS idx_links_search ON links USING GIN (to_tsvector('english', title || ' ' || description));
