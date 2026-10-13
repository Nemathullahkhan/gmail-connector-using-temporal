// npm run auth: one-time consent. Opens Google's consent page, catches the redirect on
// localhost, exchanges the code for tokens and writes GOOGLE_REFRESH_TOKEN into .env.
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { config } from './config';
import { GMAIL_SCOPES, oauthClient } from './mail/gmail';

async function main() {
  if (!config.googleClientId || !config.googleClientSecret) throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first.');
  const client = oauthClient();
  const url = client.generateAuthUrl({
    access_type: 'offline', // asks for a refresh token
    prompt: 'consent', // makes Google return one even if you consented before
    scope: GMAIL_SCOPES,
    login_hint: config.gmailUser || undefined,
  });
  console.log(`Open this URL and approve access:\n\n${url}\n`);

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', `http://localhost:${config.oauthRedirectPort}`);
      if (u.pathname !== '/oauth2callback') return void res.writeHead(404).end();
      const c = u.searchParams.get('code');
      res.end(c ? 'Done. You can close this tab.' : 'No code received.');
      server.close();
      c ? resolve(c) : reject(new Error(`Consent failed: ${u.searchParams.get('error')}`));
    });
    server.listen(config.oauthRedirectPort);
  });

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) throw new Error('Google returned no refresh token. Remove the app at myaccount.google.com/permissions and run again.');
  const envPath = path.join(config.root, '.env');
  const old = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const line = `GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`;
  fs.writeFileSync(envPath, /^GOOGLE_REFRESH_TOKEN=.*$/m.test(old) ? old.replace(/^GOOGLE_REFRESH_TOKEN=.*$/m, line) : `${old.replace(/\n?$/, '\n')}${line}\n`);
  console.log('Saved GOOGLE_REFRESH_TOKEN to .env');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
