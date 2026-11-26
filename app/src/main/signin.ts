// Spots a command waiting on a browser sign-in (`gh auth login`, `az login`, `gcloud auth login`,
// OAuth device flows…) in a tool's output, so the user can be shown the link and the code. Agents run
// headless: the command prints a URL (and often a one-time code) and waits, with no browser to open on
// an SSH host and no sign of which agent asked on this computer. Conservative on purpose: a URL counts
// only at a known sign-in address, as an OAuth authorize request, or right next to sign-in wording.

export interface SignInRequest {
  /** http(s) only. */
  url: string;
  /** One-time / device code to enter on that page, when the output gave one. */
  code?: string;
}

/** Only the tail of a long output is looked at: a prompt that is waiting is at the end. */
const WINDOW = 6000;

const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-_]/g;
const URL_RE = /https?:\/\/[^\s"'<>`\\{}|^]+/g;
const LOCAL_HOST = /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1?\])$/i;

/** Sign-in pages that are one by themselves (device flows and CLI logins). */
const KNOWN: RegExp[] = [
  /^github\.com\/login\/(?:device|oauth\/authorize)/,
  /^(?:www\.)?microsoft\.com\/(?:[a-z-]+\/)?devicelogin/,
  /^aka\.ms\/devicelogin/,
  /^login\.microsoftonline\.com\/[^/]+\/oauth2\/(?:v2\.0\/)?(?:deviceauth|authorize)/,
  /^accounts\.google\.com\/(?:o\/oauth2|signin\/oauth|device)/,
  /^(?:www\.)?google\.com\/device/,
  /^login\.tailscale\.com\/a\//,
  /^device\.sso\.[a-z0-9-]+\.amazonaws\.com/,
  /^(?:www\.)?npmjs\.com\/login\/cli\//,
  /^[^/]+\/(?:login\/device|oauth\/device|devicelogin|device\/code|activate\?user_code=)/,
];

/** Sign-in wording near a URL (same line or the two lines above it). */
const PHRASE =
  /\b(?:one[- ]time (?:code|password)|(?:device|user|verification|activation|pairing) code|device (?:login|activation|authori[sz]ation)|enter (?:the|this|your) code|verification (?:url|uri|link|page)|(?:login|log-in|sign[- ]?in|auth(?:entication|ori[sz]ation)?) (?:url|link|page)|(?:to|and) (?:sign|log) ?in\b|login at|to authenticate|to authori[sz]e|authori[sz]e (?:this|the|your) (?:device|app|application|cli|request|access|account)|complete (?:the )?(?:sign[- ]?in|login|authentication|authori[sz]ation))/i;

/** Lines that point at help, not at a sign-in waiting to happen. */
const NOT_PROMPT = /\b(?:fail(?:ed|ure)?|error|docs?|documentation|learn more|troubleshoot\w*|see https?)\b/i;

/** Wording that introduces a code; the code itself follows (case-sensitive check below). */
const CODE_LEAD = /\b(?:one[- ]time code|(?:device|user|verification|activation|pairing) code|enter (?:(?:the|this|your) )?code|your code|code is)\b/gi;
const CODE = /^[\s:："'`*(]*([A-Z0-9]{3,10}(?:-[A-Z0-9]{3,10}){0,3})(?![A-Za-z0-9])/;

function trimUrl(u: string): string {
  let url = u.replace(/[.,;:!?'")\]>]+$/, '');
  // A closing parenthesis that opened inside the URL stays.
  if (u.length > url.length && u[url.length] === ')' && (url.match(/\(/g)?.length ?? 0) > (url.match(/\)/g)?.length ?? 0)) url += ')';
  return url;
}

function parse(url: string): URL | undefined {
  try {
    const p = new URL(url);
    return (p.protocol === 'https:' || p.protocol === 'http:') && p.hostname && !LOCAL_HOST.test(p.hostname) ? p : undefined;
  } catch {
    return undefined;
  }
}

/** A URL that is a sign-in request by its address alone. */
function strong(p: URL): boolean {
  const hostPath = `${p.hostname}${p.pathname}${p.search}`.toLowerCase();
  if (KNOWN.some((re) => re.test(hostPath))) return true;
  const q = p.searchParams;
  if (q.has('user_code')) return true;
  // An OAuth authorization request (authorization-code / PKCE flows print these).
  return /\/(?:oauth2?|authorize|auth|o\/oauth2)(?:\/|$)/i.test(p.pathname) && q.has('client_id') && (q.has('response_type') || q.has('redirect_uri') || q.has('code_challenge'));
}

function codeIn(text: string, url: URL | undefined): string | undefined {
  const fromUrl = url?.searchParams.get('user_code');
  let found: string | undefined;
  for (const m of text.matchAll(CODE_LEAD)) {
    // A note in parentheses may sit between the words and the code: "(expires in 15 minutes)".
    const c = CODE.exec(text.slice(m.index! + m[0].length, m.index! + m[0].length + 80).replace(/^[^(\n]{0,3}\([^)\n]{0,40}\)/, ''));
    // A code has a digit or a dash, or is a long all-capitals token (not a word like "OK").
    if (c && (/[\d-]/.test(c[1]) || c[1].length >= 6) && !/^(?:HTTPS?|URL|CODE)$/.test(c[1])) found = c[1];
  }
  return found ?? fromUrl ?? undefined;
}

/**
 * The sign-in request in this output, if it has one (the latest, when there are several).
 * `streaming`: more may follow, so a link the output ends on may be cut short; only a known sign-in
 * page counts there (and is updated when the rest arrives).
 */
export function detectSignIn(output: string, opts: { streaming?: boolean } = {}): SignInRequest | undefined {
  if (!output || !/https?:\/\//i.test(output)) return undefined;
  const text = output.slice(-WINDOW).replace(ANSI, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  let best: { url: string; parsed: URL; line: number; strong: boolean } | undefined;
  lines.forEach((line, i) => {
    for (const m of line.matchAll(URL_RE)) {
      const url = trimUrl(m[0]);
      const p = parse(url);
      if (!p) continue;
      const isStrong = strong(p);
      const cut = opts.streaming && i === lines.length - 1 && m.index! + m[0].length === line.length;
      if (cut && !isStrong) continue;
      if (!isStrong) {
        const near = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
        if (!PHRASE.test(near) || NOT_PROMPT.test(line)) continue;
      }
      // A known sign-in page wins over a URL that only has wording nearby; otherwise the latest.
      if (!best || isStrong || !best.strong) best = { url, parsed: p, line: i, strong: isStrong };
    }
  });
  if (!best) return undefined;
  // The code is printed next to its link: a few lines around it.
  const around = lines.slice(Math.max(0, best.line - 4), best.line + 5).join('\n');
  const code = codeIn(around, best.parsed);
  return { url: best.url, ...(code ? { code } : {}) };
}

/** Where the link goes, for the headline. */
export function signInHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
