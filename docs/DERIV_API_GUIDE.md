# Deriv API connection guide

## 1. Register your app (required for "Log in with Deriv")
At **api.deriv.com → Dashboard → Register application** create an app with:
- **Redirect URL** = the address of your site, e.g. `https://trade.yourdomain.com/`. Deriv sends users
  back there after login. The site reads the tokens from the address, posts them to the backend and
  wipes them from the address bar immediately.
- **Scopes**: Read, Trade, Trading information. Never request Payments or Admin.
- Put the app id in `DERIV_APP_ID`. `1089` is Deriv's public test id and cannot redirect to your domain.

## 2. How sign-in works
```
Your site ── "Log in with Deriv" ──► oauth.deriv.com/oauth2/authorize?app_id=YOUR_ID
                                      (Deriv's page: email, password, 2FA)
Your site ◄── https://your.site/?acct1=CR..&token1=a1-..&cur1=usd&acct2=VRTC..&token2=a1-..
backend: authorize every token with Deriv → same Deriv user? → create/update user → site session
```
Users never type their Deriv password on your site. Each linked account (demo, real, each currency)
arrives with its own token. The demo account is selected by default.

## 3. Switching accounts & real money
The top bar lists the user's accounts. Switching requires all their bots to be stopped. On a real
account nothing trades until the user authorizes it in **Settings → Real-money authorization**
(type the account id and `I ACCEPT REAL MONEY RISK`). Authorization is per account.

## 4. Signing out / revoking
*Sign out on all devices* invalidates every site session of that user. *Disconnect Deriv & sign
out* also stops their bots and logs the Deriv tokens out, so the site can no longer trade for them.
Users can also revoke the app any time on Deriv under **Security → Connected apps**.

## 5. Markets
Use **Charts & Analysis** to browse what your account can trade (`active_symbols`). Common
synthetic symbols: `R_10 R_25 R_50 R_75 R_100` (Volatility indices, 2 s ticks) and
`1HZ10V … 1HZ100V` (1 s ticks). Forex/commodities only trade during market hours.

## 6. Contract types supported

| Family (`contract.family`) | Deriv types | Notes |
|---|---|---|
| `rise_fall` | CALL / PUT | default; equal exit = loss |
| `higher_lower` | CALL / PUT + barrier | barrier = `barrier_atr_mult × ATR` from spot |
| `touch` / `no_touch` | ONETOUCH / NOTOUCH | barrier in the signal direction |
| `multiplier` | MULTUP / MULTDOWN | `multiplier`, optional `sl_pct_of_stake`, `tp_pct_of_stake` (Deriv limit orders) |
| `digits_over_under`, `digits_even_odd` | DIGIT* | builders/validation exist, but no directional strategy may use them: last digits are uniformly random by design |

Before each purchase the engine checks the contract is offered for that symbol and duration
(`contracts_for`), requests a live proposal, verifies ask ≤ approved stake (max loss = stake for
all these products) and that the live payout is not more than 5 % below the bot's assumed payout.

## 7. Rate limits & reliability
The client reconnects with exponential backoff, re-authorizes and restores every subscription.
Long history downloads are paginated (5 000 candles/call) and cached in the database.
