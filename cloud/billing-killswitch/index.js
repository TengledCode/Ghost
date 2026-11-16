// Ghost's billing switch-off (runs on Google Cloud, not on the PC).
// Ghost's Google Cloud project has a budget that reports its cost to a Pub/Sub topic several times a
// day. The moment any real cost shows, this unlinks billing from Ghost's project, which stops every
// paid service there (Ghost's Google voice); Ghost then falls back to the free Edge voice.
// It can only ever touch PROJECT: its service account holds Project Billing Manager on that
// project alone, so Chronos and anything else on the billing account are out of its reach.
// Turning billing back on is done by hand (Billing → Account management → link the project).

const functions = require('@google-cloud/functions-framework');

const PROJECT = 'ghost-companion-680387';
const BILLING = `https://cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`;

async function token() {
  const res = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers: { 'Metadata-Flavor': 'Google' } });
  return (await res.json()).access_token;
}

functions.cloudEvent('killswitch', async event => {
  let report;
  try { report = JSON.parse(Buffer.from(event.data.message.data, 'base64').toString()); }
  catch { console.log('not a budget report, ignored'); return; } // returning ends Pub/Sub's retries
  const cost = Number(report.costAmount);
  console.log(JSON.stringify({ budget: report.budgetDisplayName, cost, currency: report.currencyCode, period: report.costIntervalStart }));
  if (!(cost > 0)) return; // free so far: nothing to do

  // Unlink straight away (doing it again when it's already off is harmless). No "is it on?" check
  // first: a check that fails for lack of permission must never pass for "already off".
  const res = await fetch(BILLING, { method: 'PUT', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ billingAccountName: '' }) });
  if (!res.ok) throw new Error(`could not turn billing off: ${res.status} ${await res.text()}`); // thrown: Pub/Sub tries again
  console.log(`billing turned off for ${PROJECT} at a cost of ${cost} ${report.currencyCode}`);
});
