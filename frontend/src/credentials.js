/** Deriv redirects back with ?acct1=..&token1=..&cur1=..&acct2=.. after its own login page. */
export function readOAuthRedirect(search = globalThis.location?.search || '') {
  const q = new URLSearchParams(search)
  const accounts = []
  for (let i = 1; q.get(`token${i}`); i++) {
    accounts.push({ loginid: q.get(`acct${i}`), token: q.get(`token${i}`), currency: q.get(`cur${i}`) })
  }
  return accounts
}

/** Pasted text -> accounts: the address Deriv sent you to (…?acct1=..&token1=..) or API tokens. */
export function parseCredentials(text) {
  const t = String(text || '').trim()
  if (/(^|[?&])token1=/.test(t)) return readOAuthRedirect(t.slice(t.indexOf('?') + 1).split('#')[0])
  return t.split(/[\s,;]+/).filter((x) => /^[\w-]{8,}$/.test(x)).map((token) => ({ token }))
}
