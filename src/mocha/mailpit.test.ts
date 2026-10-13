// Integration test: needs a real Mailpit (mailpit --smtp :1026 --listen :8026). Skipped when it is not running.
import * as assert from 'node:assert';
import { config } from '../config';
import { NotFoundError } from '../mail/errors';
import { getMessage, listMessagesSince, sendMail } from '../mail/mailpit';

describe('mailpit adapter (integration)', function () {
  before(async function () {
    try {
      await fetch(`${config.mailpitUrl}/api/v1/info`);
    } catch {
      this.skip();
    }
  });

  it('sends a mail, lists it, and reads it back', async () => {
    const subject = `it-${Date.now()}`;
    await sendMail({ requestId: 'it', to: ['me@example.com'], subject, text: 'body' }, '<it@example.com>');
    const list = (await (await fetch(`${config.mailpitUrl}/api/v1/search?query=subject:${subject}`)).json()) as {
      messages: { ID: string; Created: string }[];
    };
    assert.strictEqual(list.messages.length, 1);
    const mail = await getMessage(list.messages[0].ID);
    assert.strictEqual(mail.subject, subject);
    assert.strictEqual(mail.text.trim(), 'body');
    const since = await listMessagesSince(list.messages[0].Created);
    assert.ok(since.ids.includes(list.messages[0].ID));
    assert.ok(since.nextCursor);
  });

  it('getMessage throws NotFoundError for an unknown id', async () => {
    await assert.rejects(getMessage('doesnotexist'), NotFoundError);
  });
});
