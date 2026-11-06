#!/usr/bin/env node
/**
 * scripts/release.js: publish and manage app updates on Cloudflare R2.
 * See docs/APP_UPDATES.md (release runbook).
 * ---------------------------------------------------------------------------
 * Bucket layout (the app reads <UPDATE_BASE_URL>/win/<arch>/<channel>/latest.yml):
 *
 *   win/x64/stable/latest.yml            what stable PCs install next
 *   win/x64/stable/Virunthagam POS-1.2.0.exe (+ .blockmap)
 *   win/x64/stable/versions/1.2.0.yml    a copy of each published latest.yml (for rollback)
 *   win/x64/beta/...                     same, for the pilot PC(s)
 *   win/ia32/...                         same, for the 32-bit installer
 *
 * Commands (run on the release PC after `npm run package`):
 *   npm run release -- upload  [--channel beta|stable] [--arch x64|ia32] [--stage 10] [--notes notes.txt]
 *   npm run release -- stage   <percent> [--channel ...] [--arch ...]
 *   npm run release -- promote <version> [--stage 10] [--arch ...]     copy a beta release to stable
 *   npm run release -- rollback <version> [--channel ...] [--arch ...] point latest.yml back at an older version
 *   npm run release -- status  [--channel ...] [--arch ...]
 *   npm run release -- prune   [--keep 3] [--channel ...] [--arch ...] delete installers older than the last N
 *
 * Write keys come from .env.release (never .env.build, never the app):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 * Defaults: --channel stable, --arch x64, --stage 10 for stable uploads (100 for beta).
 * ---------------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');

const root = path.join(__dirname, '..');
const releaseDir = path.join(root, 'release');

// ---------------------------------------------------------------------------
// Arguments and settings
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}

function loadEnvRelease() {
  const file = path.join(root, '.env.release');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      if (!process.env[k]) process.env[k] = t.slice(i + 1).trim();
    }
  }
  const missing = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].filter(
    (k) => !process.env[k],
  );
  if (missing.length) fail(`Missing ${missing.join(', ')}. Copy .env.release.example to .env.release and fill it in.`);
}

function fail(msg) {
  console.error(`\n[release] ${msg}\n`);
  process.exit(1);
}

function choice(value, allowed, name) {
  const v = value === undefined || value === true ? allowed[0] : String(value);
  if (!allowed.includes(v)) fail(`--${name} must be one of: ${allowed.join(', ')}`);
  return v;
}

function percent(value, fallback) {
  if (value === undefined || value === true) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 100) fail('The staging percentage must be a whole number from 0 to 100.');
  return n;
}

// ---------------------------------------------------------------------------
// R2 (S3 API)
// ---------------------------------------------------------------------------
let s3;
function client() {
  if (!s3) {
    s3 = new S3Client({
      region: 'auto',
      // R2_ENDPOINT only for testing against a local S3 server.
      endpoint: process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      forcePathStyle: Boolean(process.env.R2_ENDPOINT),
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3;
}
const bucket = () => process.env.R2_BUCKET;

const YML = { ContentType: 'text/yaml; charset=utf-8', CacheControl: 'no-cache, no-store, max-age=0' };
const BIN = { ContentType: 'application/octet-stream', CacheControl: 'public, max-age=31536000, immutable' };

async function put(key, body, meta) {
  await client().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ...meta }));
  console.log(`  uploaded ${key}`);
}

async function exists(key) {
  try {
    await client().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
    return true;
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return false;
    throw err;
  }
}

async function getText(key) {
  try {
    const res = await client().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    return await res.Body.transformToString();
  } catch (err) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NoSuchKey') return null;
    throw err;
  }
}

async function copy(fromKey, toKey, meta) {
  await client().send(
    new CopyObjectCommand({
      Bucket: bucket(),
      CopySource: `${bucket()}/${fromKey.split('/').map(encodeURIComponent).join('/')}`,
      Key: toKey,
      MetadataDirective: 'REPLACE',
      ...meta,
    }),
  );
  console.log(`  copied ${fromKey} -> ${toKey}`);
}

async function list(prefix) {
  const keys = [];
  let token;
  do {
    const res = await client().send(
      new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefix, ContinuationToken: token }),
    );
    for (const o of res.Contents ?? []) keys.push(o.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

// ---------------------------------------------------------------------------
// latest.yml helpers
// ---------------------------------------------------------------------------
const folder = (arch, channel) => `win/${arch}/${channel}`;

function dumpYml(info) {
  return yaml.dump(info, { lineWidth: -1 });
}

/** The installer file names latest.yml refers to (relative to its folder). */
function installerNames(info) {
  const names = new Set((info.files ?? []).map((f) => f.url));
  if (info.path) names.add(info.path);
  return [...names];
}

/** Finds the local file for a latest.yml url (electron-builder may write spaces as dashes). */
function localFileFor(url) {
  const direct = path.join(releaseDir, decodeURIComponent(url));
  if (fs.existsSync(direct)) return direct;
  const norm = (s) => s.replace(/ /g, '-').toLowerCase();
  const hit = fs.readdirSync(releaseDir).find((f) => norm(f) === norm(decodeURIComponent(url)));
  return hit ? path.join(releaseDir, hit) : null;
}

function cmpVersions(a, b) {
  const p = (v) => String(v).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const x = p(a);
  const y = p(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function upload(flags) {
  const arch = choice(flags.arch, ['x64', 'ia32'], 'arch');
  const channel = choice(flags.channel, ['stable', 'beta'], 'channel');
  const stage = percent(flags.stage, channel === 'beta' ? 100 : 10);
  const ymlPath = path.join(releaseDir, 'latest.yml');
  if (!fs.existsSync(ymlPath)) fail('release/latest.yml not found. Run `npm run package` (or package:win32) first.');

  const info = yaml.load(fs.readFileSync(ymlPath, 'utf8'));
  const pkgVersion = require(path.join(root, 'package.json')).version;
  if (info.version !== pkgVersion) {
    fail(`release/latest.yml is version ${info.version} but package.json says ${pkgVersion}. Rebuild first.`);
  }
  const prefix = folder(arch, channel);
  const current = await getText(`${prefix}/latest.yml`);
  if (current) {
    const cur = yaml.load(current);
    if (cmpVersions(info.version, cur.version) <= 0 && !flags.force) {
      fail(`${prefix} already offers ${cur.version}. Bump the version (npm version patch) and rebuild. PCs never downgrade.`);
    }
  }

  if (flags.notes) {
    const notesFile = path.resolve(String(flags.notes));
    if (!fs.existsSync(notesFile)) fail(`Notes file not found: ${notesFile}`);
    info.releaseNotes = fs.readFileSync(notesFile, 'utf8').trim();
  }
  info.stagingPercentage = stage;

  console.log(`\n[release] Uploading ${info.version} to ${prefix} at ${stage}% of PCs`);
  // 1) installers and blockmaps first, 2) the archive copy, 3) latest.yml last,
  // so no PC ever reads a latest.yml that points at a file not uploaded yet.
  for (const url of installerNames(info)) {
    const local = localFileFor(url);
    if (!local) fail(`Installer for "${url}" not found in release/.`);
    await put(`${prefix}/${url}`, fs.readFileSync(local), BIN);
    const blockmap = `${local}.blockmap`;
    if (fs.existsSync(blockmap)) await put(`${prefix}/${url}.blockmap`, fs.readFileSync(blockmap), BIN);
    else console.warn(`  (no ${path.basename(blockmap)}; PCs will download the whole installer)`);
  }
  const text = dumpYml(info);
  await put(`${prefix}/versions/${info.version}.yml`, text, YML);
  await put(`${prefix}/latest.yml`, text, YML);
  console.log(`\n[release] Done. ${stage}% of ${channel} PCs (${arch}) get ${info.version} at their next check (within 4 hours).`);
  if (channel === 'stable' && stage < 100) {
    console.log(`          Widen later with: npm run release -- stage 50   (then 100)`);
  }
}

async function stage(positional, flags) {
  const arch = choice(flags.arch, ['x64', 'ia32'], 'arch');
  const channel = choice(flags.channel, ['stable', 'beta'], 'channel');
  const pct = percent(positional[1], NaN);
  if (Number.isNaN(pct)) fail('Usage: npm run release -- stage <0-100>');
  const prefix = folder(arch, channel);
  const text = await getText(`${prefix}/latest.yml`);
  if (!text) fail(`Nothing published in ${prefix} yet.`);
  const info = yaml.load(text);
  info.stagingPercentage = pct;
  const out = dumpYml(info);
  await put(`${prefix}/versions/${info.version}.yml`, out, YML);
  await put(`${prefix}/latest.yml`, out, YML);
  console.log(`\n[release] ${info.version} in ${prefix} now offered to ${pct}% of PCs.`);
  if (pct === 0) console.log('          Stopped: PCs that have not downloaded it yet will not get it.');
}

async function promote(positional, flags) {
  const arch = choice(flags.arch, ['x64', 'ia32'], 'arch');
  const version = positional[1];
  if (!version) fail('Usage: npm run release -- promote <version> [--stage 10]');
  const pct = percent(flags.stage, 10);
  const from = folder(arch, 'beta');
  const to = folder(arch, 'stable');
  const text = await getText(`${from}/versions/${version}.yml`);
  if (!text) fail(`${from}/versions/${version}.yml not found. Was ${version} uploaded to beta?`);
  const info = yaml.load(text);
  const current = await getText(`${to}/latest.yml`);
  if (current && cmpVersions(version, yaml.load(current).version) <= 0 && !flags.force) {
    fail(`${to} already offers ${yaml.load(current).version}. Promote a higher version.`);
  }
  console.log(`\n[release] Promoting ${version} from beta to stable at ${pct}%`);
  for (const url of installerNames(info)) {
    await copy(`${from}/${url}`, `${to}/${url}`, BIN);
    if (await exists(`${from}/${url}.blockmap`)) await copy(`${from}/${url}.blockmap`, `${to}/${url}.blockmap`, BIN);
  }
  info.stagingPercentage = pct;
  const out = dumpYml(info);
  await put(`${to}/versions/${version}.yml`, out, YML);
  await put(`${to}/latest.yml`, out, YML);
  console.log('\n[release] Done.');
}

async function rollback(positional, flags) {
  const arch = choice(flags.arch, ['x64', 'ia32'], 'arch');
  const channel = choice(flags.channel, ['stable', 'beta'], 'channel');
  const version = positional[1];
  if (!version) fail('Usage: npm run release -- rollback <older version>');
  const prefix = folder(arch, channel);
  const text = await getText(`${prefix}/versions/${version}.yml`);
  if (!text) fail(`${prefix}/versions/${version}.yml not found.`);
  const info = yaml.load(text);
  for (const url of installerNames(info)) {
    if (!(await exists(`${prefix}/${url}`))) fail(`${prefix}/${url} was deleted (pruned); cannot roll back to ${version}.`);
  }
  info.stagingPercentage = 100;
  await put(`${prefix}/latest.yml`, dumpYml(info), YML);
  console.log(`
[release] ${prefix}/latest.yml points at ${version} again.
          PCs still on ${version} or older stay there (or get ${version}).
          PCs that already installed the newer version are NOT downgraded:
          publish a fixed, higher version (e.g. rebuild the good code as the next patch),
          and if they must move now, add the bad version to blocked_versions in app_release_policy.`);
}

async function status(flags) {
  const arch = choice(flags.arch, ['x64', 'ia32'], 'arch');
  const channel = choice(flags.channel, ['stable', 'beta'], 'channel');
  const prefix = folder(arch, channel);
  const text = await getText(`${prefix}/latest.yml`);
  console.log(`\n[release] ${prefix}/latest.yml`);
  console.log(text ? text : '  (nothing published)');
  const versions = (await list(`${prefix}/versions/`))
    .map((k) => path.basename(k, '.yml'))
    .sort(cmpVersions);
  console.log(`Archived versions: ${versions.join(', ') || 'none'}`);
}

async function prune(flags) {
  const arch = choice(flags.arch, ['x64', 'ia32'], 'arch');
  const channel = choice(flags.channel, ['stable', 'beta'], 'channel');
  const keep = flags.keep === undefined ? 3 : Number(flags.keep);
  if (!Number.isInteger(keep) || keep < 2) fail('--keep must be 2 or more.');
  const prefix = folder(arch, channel);
  const latest = await getText(`${prefix}/latest.yml`);
  const live = latest ? yaml.load(latest).version : null;
  const versions = (await list(`${prefix}/versions/`)).map((k) => path.basename(k, '.yml')).sort(cmpVersions);
  const old = versions.slice(0, Math.max(0, versions.length - keep)).filter((v) => v !== live);
  if (!old.length) return console.log(`\n[release] Nothing to prune in ${prefix}.`);
  const keys = [];
  for (const v of old) {
    const info = yaml.load(await getText(`${prefix}/versions/${v}.yml`));
    for (const url of installerNames(info)) keys.push(`${prefix}/${url}`, `${prefix}/${url}.blockmap`);
  }
  await client().send(
    new DeleteObjectsCommand({ Bucket: bucket(), Delete: { Objects: keys.map((Key) => ({ Key })) } }),
  );
  console.log(`\n[release] Deleted installers of ${old.join(', ')} (their versions/*.yml are kept as a record).`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  const commands = ['upload', 'stage', 'promote', 'rollback', 'status', 'prune'];
  if (!commands.includes(cmd)) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 27).join('\n'));
    process.exit(cmd ? 1 : 0);
  }
  loadEnvRelease();
  if (cmd === 'upload') return upload(flags);
  if (cmd === 'stage') return stage(positional, flags);
  if (cmd === 'promote') return promote(positional, flags);
  if (cmd === 'rollback') return rollback(positional, flags);
  if (cmd === 'status') return status(flags);
  if (cmd === 'prune') return prune(flags);
}

main().catch((err) => fail(err?.message ?? String(err)));
