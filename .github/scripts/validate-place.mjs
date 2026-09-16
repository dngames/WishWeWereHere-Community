/**
 * Read the place link in a `showcase` issue and say what it is.
 *
 * A gallery only works while its links work, and there are exactly two ways one stops working: it is a
 * **short link** (`/s/<id>`), which points at a row on the server that is deleted after 30 days, or it
 * arrived **mangled** — wrapped, truncated, or HTML-escaped on the way through a chat app. Both are
 * invisible to the person who pasted it, and both are cheap to catch here.
 *
 * What this reads, and what it deliberately does not:
 *
 *   - `#txt=…` — read in full. It is plain text: a world, an optional title, and `p=type@x,y,z` per
 *     object, so the objects can be listed by name.
 *   - `#j=…` — read in full. That is the older JSON form: zlib, then base64url, then plain JSON.
 *   - `#s=…` — the **Store link**, and the one this gallery wants. Its payload is the app's own codec
 *     (`w1`/`w2` + its own LZ and alphabet), which lives in the app repository and stays there: this
 *     repository is public and that one is not, so the decoder is not copied here. What can be checked
 *     without it is checked — that the payload starts with `w1`/`w2`, and that every character is one
 *     the alphabet allows — which is enough to catch a link that was wrapped or edited.
 *   - `/s/<id>` — named, and warned about. 30 days.
 *
 * It never edits the issue, and it leaves exactly one comment, which it updates rather than repeats.
 */

import { inflateSync } from 'node:zlib';

const MARKER = '<!-- wwwh-place-validator -->';

/* ── Reading the fragment ───────────────────────────────────────────────── */

/** The address the app answers on, and the one its links should be written on. */
const APP_HOSTS = new Set(['idyll.cc', 'www.idyll.cc', 'www.dngames.de', 'dngames.de']);

/** `#s=w2…`: the payload begins with the two characters that name its generation. */
const STORE_GENERATIONS = new Set(['w1', 'w2']);

const isStorePayload = (payload) => /^[A-Za-z0-9_-]+$/.test(payload);

function readText(payload) {
  // `theme=…&title=…&p=type@x,y,z`, with `+` or %20 for spaces. Not a query string in a document,
  // just the app's own `#txt=` grammar, so it is split by hand rather than by URLSearchParams.
  const fields = new Map();
  const objects = [];
  for (const part of payload.split('&')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1).replace(/\+/g, ' ');
    if (key === 'p') objects.push(value.split('@')[0]);
    else fields.set(key, value);
  }
  return { theme: fields.get('theme') ?? null, title: fields.get('title') ?? null, objects };
}

function readJson(payload) {
  // base64url → zlib → JSON. The alphabet is the url-safe one, so it is translated before decoding.
  const bytes = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const json = JSON.parse(inflateSync(bytes).toString('utf8'));
  const props = Array.isArray(json?.props) ? json.props : [];
  return {
    theme: json?.theme ?? null,
    title: json?.meta?.title ?? null,
    objects: props.map((p) => p?.type).filter(Boolean),
  };
}

/** Everything this can say about one candidate URL. */
function inspect(url) {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const onApp = APP_HOSTS.has(host);
  const short = /^\/s\/([A-Za-z0-9_-]{16}|[A-Za-z0-9_-]{22})(?:\.([A-Za-z0-9_-]{22}|[A-Za-z0-9_-]{43}))?\/?$/.exec(parsed.pathname);

  if (short) {
    return { kind: 'short', host, id: short[1], picture: !!short[2] };
  }

  const hash = parsed.hash.replace(/^#/, '');
  /*
   * The payload runs to the **end** of the fragment, not to the first `&`: the plain-text form is
   * `#txt=theme=…&title=…&p=…&p=…`, so stopping at the first separator loses every object after the
   * world. Nothing else in a fragment follows a payload, so the rest of it is the payload.
   */
  const store = /(?:^|&)s=(.*)$/.exec(hash);
  const json = /(?:^|&)j=(.*)$/.exec(hash);
  const text = /(?:^|&)txt=(.*)$/.exec(hash);
  const legacy = /(?:^|&)p=/.test(hash);

  if (store && store[1]) return { kind: 'store', host, payload: store[1] };
  if (json && json[1]) return { kind: 'json', host, payload: json[1] };
  if (text && text[1]) return { kind: 'text', host, payload: text[1] };
  if (legacy) return { kind: 'legacy', host };
  return { kind: 'bare', host, onApp };
}

/* ── Saying it ──────────────────────────────────────────────────────────── */

const list = (names, limit = 8) => (names.length > limit
  ? `${names.slice(0, limit).join(', ')}, and ${names.length - limit} more`
  : names.join(', '));

function lines(place) {
  if (place.kind === 'store') {
    const generation = place.payload.slice(0, 2);
    const known = STORE_GENERATIONS.has(generation);
    const clean = isStorePayload(place.payload);
    /*
     * A green tick only when the payload is shaped like one the app writes. A link that was wrapped,
     * escaped or cut is the failure this check exists for, and calling that "✅ a Store link" would
     * be worse than saying nothing.
     */
    if (!known || !clean) {
      const why = [];
      if (!known) why.push(`its payload begins \`${generation}\`, and the app writes \`w1\` or \`w2\``);
      if (!clean) why.push('it contains characters the payload alphabet never uses, so something wrapped or escaped it');
      return [
        '⚠️ **This link does not look like one the app wrote** — it may have been shortened, wrapped or edited on the way here.',
        '',
        `What is wrong: ${why.join('; ')}.`,
        '',
        'Please copy it again with the app\'s **Store** button — the whole thing, unedited — and paste it on its own line.',
      ];
    }
    return [
      `✅ **A Store link** on \`${place.host}\` — ${place.payload.length} characters of the \`${generation}\` form, and every character is one the payload allows.`,
      '',
      'The scene itself is read by the app: its decoder stays in the app repository, and this one is public, so nothing here pretends to open it. A person will check it before it reaches the gallery.',
    ];
  }

  if (place.kind === 'json' || place.kind === 'text') {
    let scene = null;
    try {
      scene = place.kind === 'json' ? readJson(place.payload) : readText(place.payload);
    } catch (err) {
      return [`❌ **This link could not be read**: ${err.message}.`, '', 'Paste it again exactly as the app copied it — whole, and unedited.'];
    }
    const what = place.kind === 'json' ? 'the older JSON form, which still opens' : 'the plain-text form';
    return [
      `✅ **Readable** — ${what}, on \`${place.host}\`.`,
      '',
      `- world: \`${scene.theme ?? 'none named'}\``,
      `- name: ${scene.title ? `“${scene.title}”` : '—'}`,
      `- objects: ${scene.objects.length ? `${scene.objects.length} — ${list(scene.objects)}` : 'none'}`,
      ...(place.kind === 'text' ? ['', 'The plain-text form carries types and positions only — no colours, sizes or parameters — so the app may show it slightly differently from what the sender saw.'] : []),
    ];
  }

  if (place.kind === 'short') {
    return [
      '⚠️ **This is the short link, not the Store link.**',
      '',
      'It points at a row on the server that is **deleted 30 days after it was made**, so the place would vanish from the gallery while the link stayed behind.',
      '',
      'Open the place, press **Store** in the Send panel (under the link), and paste that instead — the whole scene travels inside it and it does not expire.',
      ...(place.picture ? ['', 'It also carries a picture key, which the Store link does not need — the postcard below covers that.'] : []),
    ];
  }

  if (place.kind === 'legacy') {
    return ['⚠️ **This is a very old link form** (`#p=`). It may still open, but it is not what the app makes today — please paste the **Store** link from the Send panel.'];
  }

  return [
    '❌ **I could not find a place link in this issue.**',
    '',
    'Open the place in the app, press **Store** in the Send panel, and paste that whole link here. It is long — that is the scene travelling inside the address — and it must not be shortened or edited.',
  ];
}

/** The whole comment: what the link is, then the two things people forget. */
function comment(issue, places) {
  const body = String(issue.body ?? '');
  const hasPicture = /!\[[^\]]*\]\(https:\/\/github\.com\/user-attachments|!\[[^\]]*\]\(https:\/\/(?:user-images|private-user-images)\.githubusercontent\.com/.test(body);
  const parts = places.length ? lines(places[0]) : lines({ kind: 'bare' });

  /*
   * The nudge only when there *is* a place link: an issue with no link at all is already being asked
   * for one, and a second paragraph about a missing picture would be noise on top of that.
   */
  if (places.length && !hasPicture) {
    parts.push('', '🖼️ **No postcard attached.** A link cannot preview as the place it opens — GitHub, like every chat app, never receives the part of an address after `#` — so the picture is what the gallery shows. In the app, press **Save postcard** next to the link and drag the image in above.');
  }
  if (places.length > 1) {
    parts.push('', `_(${places.length} place links in this issue; I read the first one.)_`);
  }
  parts.push('', '---', '<sub>Checked automatically. A person still decides what goes in the gallery.</sub>');
  return `${MARKER}\n${parts.join('\n')}`;
}

/* ── One comment, updated rather than repeated ──────────────────────────── */

async function upsertComment(body) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.REPOSITORY;
  const issue = process.env.ISSUE_NUMBER;
  const api = async (path, init = {}) => {
    const res = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'wwwh-place-validator',
        'content-type': 'application/json',
      },
    });
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`);
    return res.json();
  };

  const comments = await api(`issues/${issue}/comments?per_page=100`);
  const mine = comments.find((c) => typeof c.body === 'string' && c.body.startsWith(MARKER));
  if (mine) {
    await api(`issues/comments/${mine.id}`, { method: 'PATCH', body: JSON.stringify({ body }) });
    return 'updated';
  }
  await api(`issues/${issue}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
  return 'posted';
}

/* ── Main ───────────────────────────────────────────────────────────────── */

const issue = { body: process.env.ISSUE_BODY ?? '' };

/*
 * Every http(s) URL in the issue, then the ones that are actually a place.
 *
 * The preference matters: people paste reference links, and GitHub turns a dragged-in picture into a
 * URL of its own, so the *first* URL in an issue is quite often not the place at all. A place link
 * anywhere in the issue is what gets read; a URL that is none of the known forms is only a fallback,
 * so that an issue with nothing but a broken link still gets the right message.
 */
const urls = [...issue.body.matchAll(/https?:\/\/[^\s<>()[\]"']+/g)]
  .map((m) => m[0].replace(/[.,;:]+$/, ''))
  .filter((url) => !/^https:\/\/(?:github\.com\/user-attachments|[\w.-]*githubusercontent\.com)\//.test(url));
const inspected = urls.map((url) => {
  try { return inspect(url); } catch { return null; }
}).filter(Boolean);
const places = inspected.filter((place) => place.kind !== 'bare');

const message = comment(issue, places);
console.log(`issue body: ${issue.body.length} chars, ${urls.length} URL(s), place links: ${places.map((f) => f.kind).join(', ') || 'none'}`);

if (!process.env.ISSUE_NUMBER || !process.env.GITHUB_TOKEN) {
  // Local run: print what would be said, so the wording can be tested without an issue.
  console.log('\n--- comment (not posted: no ISSUE_NUMBER/GITHUB_TOKEN) ---\n');
  console.log(message);
} else {
  console.log(`comment ${await upsertComment(message)}`);
}
