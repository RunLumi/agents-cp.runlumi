// Process environment for a spawned desktop (Electron Main -> Host -> Agent) under test. Pure: it builds a
// NEW object, never touches the supervisor's process.env or shell HOME.
//
// Three contexts are kept distinct (spec 04, "Test-profile isolation"):
//   1. Native OS keystore context (Main): HOME/USERPROFILE are COPIED UNCHANGED from the supervisor. The
//      isolated-HOME run scheduler-isolated68443 failed with lumi_secure_storage_unavailable, and the native
//      discriminator (test-results/native-secure-storage-home-control-after.json: same Electron binary/app name,
//      isolated HOME -> unavailable, inherited HOME -> available, constant XDG profile) points at HOME. Product
//      safeStorage stays fail-closed; never fake or bypass it.
//   2. Main application data: ZCODE_DATA_BASE_DIR / ZCODE_DESKTOP_USER_DATA_DIR / ZCODE_DESKTOP_SESSION_DATA_DIR
//      and constant XDG_* point inside the profile.
//   3. Host/Agent child home: ZCODE_DESKTOP_HOME_DIR=<profile>/home. Main's buildHostProcessEnv writes it as the
//      Host's (and so the Agent's) HOME/USERPROFILE, so global hooks/settings/skills/session DB cannot read the
//      personal home. The Agent-only DB variables below are pinned too but are not sufficient alone.
// A run manifest must record `describeIsolation(...)`. A profile is certified only by a FRESH replay that reads
// the Host/Agent paths back, never by this builder's output; older profiles remain UNPROVEN.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Variables that could redirect the child to personal state if inherited from the supervisor. */
const INHERITED_PERSONAL_KEYS = [
  "ZCODE_HOME",
  "ZCODE_DATA_BASE_DIR",
  "ZCODE_STORAGE_DIR",
  "ZCODE_SESSION_DB_PATH",
  "ZCODE_SESSION_DB",
  "ZCODE_LOG_DIR",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "APPDATA",
  "LOCALAPPDATA",
];

/** Main's OS identity: inherited unchanged so the native keystore resolves; Host/Agent get the profile home instead. */
const OS_IDENTITY_KEYS = ["HOME", "USERPROFILE"];

/** Roots of isolation. A caller may never override these; `isolatedChildEnv` refuses instead of letting one win. */
const PROTECTED_KEYS = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "ZCODE_HOME",
  "ZCODE_DATA_BASE_DIR",
  "ZCODE_STORAGE_DIR",
  "ZCODE_SESSION_DB_PATH",
  "ZCODE_SESSION_DB",
  "ZCODE_LOG_DIR",
  "ZCODE_DESKTOP_HOME_DIR",
  "ZCODE_DESKTOP_USER_DATA_DIR",
  "ZCODE_DESKTOP_SESSION_DATA_DIR",
  // Provider catalogs: never inherited from the supervisor, only profile-owned (see `ownedProviderConfigEnv`).
  "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
  "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
];

/** Real path of `path`, following symlinks in every existing ancestor; a not-yet-created tail is kept lexically. */
export function canonicalPath(path) {
  const absolute = resolve(path);
  const tail = [];
  let current = absolute;
  for (;;) {
    try {
      return join(realpathSync(current), ...tail);
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      assert.notEqual(parent, current, `no existing ancestor for ${absolute}`);
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

/** True when canonical `a` equals `b` or contains it. */
const isSameOrAncestor = (a, b) => {
  const rel = relative(a, b);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Directories the child owns inside the profile. */
export function isolatedHomeLayout(profile) {
  const home = join(profile, "home");
  return {
    home,
    configHome: join(home, ".config"),
    dataHome: join(home, ".local", "share"),
    cacheHome: join(home, ".cache"),
    stateHome: join(home, ".local", "state"),
    storageRoot: join(home, ".zcode"),
    agentStore: join(home, ".zcode", "cli", "db", "db.sqlite"),
    agentLogDir: join(home, ".zcode", "cli", "log"),
  };
}

/**
 * The profile, and its `home` child, must not be the operator's home or contain it. Compared on REAL paths,
 * so a symlink alias of the personal home (or a symlinked ancestor/`home`) is refused like the directory itself.
 */
export function assertProfileIsNotPersonal(profile, personalHome = homedir()) {
  assert.ok(isAbsolute(profile), "profile must be an absolute path");
  const personal = canonicalPath(personalHome);
  for (const candidate of [profile, join(profile, "home")])
    assert.ok(
      !isSameOrAncestor(canonicalPath(candidate), personal),
      "profile must not be, or contain, the operator's home directory",
    );
}

/**
 * Profile-owned provider catalogs. `personalFilePath` is where the Host itself reads personal providers
 * (`<home>/.zcode/v2/provider_config.json`); the builtin copy lives beside `home`, never in a shared cache.
 */
export function ownedProviderConfigPaths(profile) {
  return {
    builtinFilePath: join(profile, "provider-config", "zcode-builtin.json"),
    personalFilePath: join(isolatedHomeLayout(profile).storageRoot, "v2", "provider_config.json"),
  };
}

/**
 * Builtin and personal provider config env, set TOGETHER (the runtime throws if only one is given) and only
 * when the harness wrote both files into the profile. A profile without them gets nothing, so existing
 * journeys keep the product defaults, and a supervisor value is never inherited (see PROTECTED_KEYS).
 */
export function ownedProviderConfigEnv(profile) {
  const { builtinFilePath, personalFilePath } = ownedProviderConfigPaths(profile);
  if (!existsSync(builtinFilePath) || !existsSync(personalFilePath)) return {};
  for (const path of [builtinFilePath, personalFilePath])
    assert.ok(isSameOrAncestor(canonicalPath(profile), canonicalPath(path)), "provider config must live inside the profile");
  return {
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinFilePath,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalFilePath,
  };
}

/** Create the XDG directories so a child that expects them never falls back to another location. */
export function prepareIsolatedHome(profile) {
  const layout = isolatedHomeLayout(profile);
  for (const dir of [layout.home, layout.configHome, layout.dataHome, layout.cacheHome, layout.stateHome])
    mkdirSync(dir, { recursive: true });
  return layout;
}

/**
 * Environment for one spawned desktop. `overrides` carry non-isolation settings (control-plane origin, app
 * name, ...). An override of any isolation root (HOME, USERPROFILE, XDG_*, ZCODE_* data/home roots) is
 * REFUSED, and the isolation fields are applied last, so no override can undo isolation.
 * `base` defaults to the supervisor's environment, which is only COPIED.
 */
export function isolatedChildEnv(profile, overrides = {}, base = process.env) {
  assertProfileIsNotPersonal(profile);
  const protectedKeys = new Set(PROTECTED_KEYS);
  const conflicting = Object.keys(overrides).filter((key) => protectedKeys.has(key.toUpperCase()));
  assert.deepEqual(conflicting, [], `overrides may not replace isolation roots: ${conflicting.join(", ")}`);
  const layout = isolatedHomeLayout(profile);
  const inherited = { ...base };
  for (const key of Object.keys(inherited)) {
    // Main keeps the exact-case OS identity (native keystore); any other spelling or root is dropped.
    if (OS_IDENTITY_KEYS.includes(key)) continue;
    if (INHERITED_PERSONAL_KEYS.includes(key.toUpperCase()) || protectedKeys.has(key.toUpperCase())) delete inherited[key];
  }
  return {
    ...inherited,
    ...overrides,
    ...ownedProviderConfigEnv(profile),
    XDG_CONFIG_HOME: layout.configHome,
    XDG_DATA_HOME: layout.dataHome,
    XDG_CACHE_HOME: layout.cacheHome,
    XDG_STATE_HOME: layout.stateHome,
    ZCODE_DATA_BASE_DIR: layout.home,
    // Agent-only seams (config env scope: ZCODE_STORAGE_DIR / ZCODE_SESSION_DB_PATH; ZCODE_LOG_DIR). They equal
    // the values HOME isolation already yields, so they change nothing today; they pin the Agent's store, storage
    // root and logs inside the profile independently of HOME, should HOME ever need to stay real (see header).
    ZCODE_STORAGE_DIR: layout.storageRoot,
    ZCODE_SESSION_DB_PATH: layout.agentStore,
    ZCODE_LOG_DIR: layout.agentLogDir,
    ZCODE_DESKTOP_HOME_DIR: layout.home,
    ZCODE_DESKTOP_USER_DATA_DIR: join(profile, "userData"),
    ZCODE_DESKTOP_SESSION_DATA_DIR: join(profile, "session"),
    ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
  };
}

/**
 * Manifest fragment separating the native OS keystore context from app/Agent data isolation. It records which
 * context each root belongs to; it proves nothing by itself (see header: fresh replay required).
 */
export function describeIsolation(profile, env) {
  const layout = isolatedHomeLayout(profile);
  const mainHomeIsProfile = env.HOME !== undefined && canonicalPath(env.HOME) === canonicalPath(layout.home);
  return {
    nativeOsKeystore: { mainHomeIsProfile, homeSource: mainHomeIsProfile ? "profile" : "inherited-os-home" },
    mainAppData: {
      dataBaseDir: env.ZCODE_DATA_BASE_DIR,
      userData: env.ZCODE_DESKTOP_USER_DATA_DIR,
      sessionData: env.ZCODE_DESKTOP_SESSION_DATA_DIR,
    },
    hostAgentHome: { requestedRoot: env.ZCODE_DESKTOP_HOME_DIR, agentStore: env.ZCODE_SESSION_DB_PATH },
  };
}
