'use strict';

const { checkEmail } = require('../lib/checker');

const args = process.argv.slice(2);
const emails = args.length
  ? args
  : [`probe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@gmail.com`];

(async () => {
  for (const email of emails) {
    const r = await checkEmail(email);
    console.log(
      `${email.padEnd(34)} -> ${String(r.status).padEnd(15)} ` +
        `registered=${r.registered}  ${r.evidence && r.evidence.msg ? '| ' + r.evidence.msg : ''}`
    );
  }
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
