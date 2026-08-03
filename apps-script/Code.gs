/**
 * Outcome Convergence Systems (OCS) book forms -> Google Sheet + email.
 *
 * Google Apps Script Web App BOUND to a Google Sheet. The ocs-books-preview
 * Cloudflare Worker forwards each submission here AFTER writing a durable copy
 * to its OCS_BOOKS KV namespace, so the Sheet + email are the second, mutually-
 * backing copy. If this forward is ever unreachable, the Worker keeps the record
 * in KV, marks it forward_failed, and alerts ALERT_WEBHOOK -- pull the record
 * later from GET /books/export.
 *
 * Setup:
 *  1. Create a Google Sheet (this becomes the datastore). Keep it separate from
 *     the nrupalakolkar.com Sheet so book leads stay in their own workbook.
 *  2. Extensions > Apps Script. Paste this file as Code.gs.
 *  3. Set NOTIFY_EMAIL and SHARED_SECRET below (make SHARED_SECRET long/random).
 *  4. Deploy > New deployment > Web app:
 *       Execute as: Me    |    Who has access: Anyone
 *     Copy the Web app URL (ends in /exec).
 *  5. On the ocs-books-preview Worker, set secrets (values only you hold):
 *       wrangler secret put APPSCRIPT_URL      -> paste the /exec URL
 *       wrangler secret put APPSCRIPT_SECRET   -> the same SHARED_SECRET
 */

var NOTIFY_EMAIL = 'nrupalakolkar@gmail.com';
var SHARED_SECRET = 'REPLACE_WITH_A_LONG_RANDOM_STRING';

function doPost(e) {
  try {
    var data = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (SHARED_SECRET && data.secret !== SHARED_SECRET) {
      return _json({ ok: false, error: 'unauthorized' });
    }
    var type = String(data.type || 'unknown').toLowerCase();
    _append(type, data);
    _email(type, data);
    return _json({ ok: true });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

function _columns(type) {
  if (type === 'order') return ['name', 'email', 'format', 'qty', 'address'];
  if (type === 'signup') return ['email'];
  return ['email'];
}

function _append(type, d) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(type) || ss.insertSheet(type);
  var cols = _columns(type);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['timestamp'].concat(cols).concat(['ref']));
  }
  var row = [new Date()];
  for (var i = 0; i < cols.length; i++) row.push(d[cols[i]] || '');
  row.push(d.ref || d.key || '');
  sheet.appendRow(row);
}

function _email(type, d) {
  var subject, body;
  if (type === 'order') {
    subject = 'OCS book - signed copy request - ' + (d.name || '');
    body = 'New signed hard-copy request\n\n'
      + 'Name: ' + (d.name || '') + '\n'
      + 'Email: ' + (d.email || '') + '\n'
      + 'Format: ' + (d.format || '') + '\n'
      + 'Quantity: ' + (d.qty || '') + '\n'
      + 'Shipping address:\n' + (d.address || '') + '\n\n'
      + 'Ref: ' + (d.ref || d.key || '') + '\nWhen: ' + (d.ts || '');
  } else if (type === 'signup') {
    subject = 'OCS book - launch-notify signup';
    body = 'Email: ' + (d.email || '') + '\nWhen: ' + (d.ts || '');
  } else {
    subject = 'OCS book - form submission: ' + type;
    body = JSON.stringify(d, null, 2);
  }
  MailApp.sendEmail({ to: NOTIFY_EMAIL, replyTo: d.email || NOTIFY_EMAIL, subject: subject, body: body });
}

function _json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
