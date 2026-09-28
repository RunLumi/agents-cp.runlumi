-- Correct the `teams` and `team_members` primary-key checks, which no insert can
-- satisfy.
--
-- WHY
--
-- `adapters::new_resource_id(prefix)` builds `{prefix}_{32 hex}`, so a prefix of
-- N letters produces N + 1 + 32 characters. `generated_id("team")` is therefore
-- 37 characters, and `generated_id("tmem")` is 37 characters.
--
-- Migration 0002 declared:
--
--     teams.team_id         length = 36 AND substr(1, 4) = 'team'
--     team_members.team_member_id  length = 36 AND substr(1, 5) = 'tmem_'
--
-- The prefix half matches (`team_` begins with `team`) but the length half can
-- never hold, so every INSERT fails its CHECK and takes its whole D1 batch with
-- it. The team surface has therefore never worked: POST /teams answered 409,
-- POST /teams/{id}/members could never run, and project access granted through
-- team membership silently never applied, because `repositories/runs.rs` and
-- `repositories/projects.rs` read `team_members` and it was always empty.
--
-- This is the same class as the P08 platform tables, which are written at length
-- 37 and checked at 37 -- `deletion_certificates`, `cost_records` and
-- `credentials` all spell their prefix with its underscore. These two tables
-- were the outliers.
--
-- WHY A REBUILD AND NOT AN EDIT
--
-- Editing migration 0002 would fix a fresh database and nothing else: the ledger
-- records 0002 as applied, so `d1_migrations apply` would skip it. Already-
-- applied databases -- staging, production, any developer's local state -- would
-- keep the broken check. A corrective migration is the only form that reaches
-- them, and the `_new` / copy / drop / rename shape is the one this repository
-- already uses (0004, 0005, 0006).
--
-- WHY THE CHILD GOES FIRST
--
-- `team_members` references `teams` on both `team_id` and `(org_id, team_id)`,
-- both `ON DELETE CASCADE`. Dropping the parent while a child still references
-- it would cascade-delete that child. Rebuilding `team_members` first leaves the
-- parent with no referencing child, so the order here is load-bearing rather
-- than cosmetic. `team_members_new` declares the same foreign keys, and they
-- resolve by name to whichever table is called `teams` once the rename lands.
--
-- Both tables are empty, and provably so: the check being corrected is what
-- makes the insert impossible. The copies below are still written in full so the
-- migration is correct for any database that somehow holds rows.

-- ---------------------------------------------------------------- team_members
CREATE TABLE team_members_new (
    team_member_id TEXT PRIMARY KEY CHECK (
        length(team_member_id) = 37 AND substr(team_member_id, 1, 5) = 'tmem_'
    ),
    org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    team_id TEXT NOT NULL REFERENCES teams(team_id) ON DELETE CASCADE,
    membership_id TEXT NOT NULL,
    created_at TEXT NOT NULL CHECK (length(created_at) = 24),
    FOREIGN KEY (org_id, team_id) REFERENCES teams(org_id, team_id) ON DELETE CASCADE,
    FOREIGN KEY (org_id, membership_id) REFERENCES memberships(org_id, membership_id) ON DELETE CASCADE,
    CONSTRAINT uq_team_members_team_membership UNIQUE (team_id, membership_id)
);

INSERT INTO team_members_new (
    team_member_id, org_id, team_id, membership_id, created_at
)
SELECT team_member_id, org_id, team_id, membership_id, created_at
FROM team_members;

DROP TABLE team_members;
ALTER TABLE team_members_new RENAME TO team_members;

CREATE INDEX idx_team_members_org_id ON team_members (org_id, team_id);

-- ----------------------------------------------------------------------- teams
CREATE TABLE teams_new (
    team_id TEXT PRIMARY KEY CHECK (
        length(team_id) = 37 AND substr(team_id, 1, 5) = 'team_'
    ),
    org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
    slug TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 63 AND slug = lower(trim(slug))),
    created_by_user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL CHECK (length(created_at) = 24),
    updated_at TEXT NOT NULL CHECK (length(updated_at) = 24),
    CONSTRAINT uq_teams_org_slug UNIQUE (org_id, slug),
    CONSTRAINT uq_teams_org_team UNIQUE (org_id, team_id)
);

INSERT INTO teams_new (
    team_id, org_id, display_name, slug, created_by_user_id,
    version, created_at, updated_at
)
SELECT team_id, org_id, display_name, slug, created_by_user_id,
       version, created_at, updated_at
FROM teams;

DROP TABLE teams;
ALTER TABLE teams_new RENAME TO teams;

CREATE INDEX idx_teams_org_id ON teams (org_id, created_at);
