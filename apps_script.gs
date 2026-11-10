/**
 * The Well Build — Spec Book Intake
 * Backend: Google Apps Script Web App
 *
 * Separate from the inquiry form, contractor specifications and client feedback backends.
 * Keep this script bound to its own Google Sheet so submissions don't mix.
 *
 * What it does
 *   submit          Homeowner sends the form → one row in "Responses", email to Greg and Rachel
 *                   (Reply-To = homeowner), confirmation copy to the homeowner. If they chose to send
 *                   the builder questions on, the row gets a builder token and the confirmation email
 *                   carries the builder link.
 *   builder_lookup  Builder link opens → returns the project address and homeowner's first name.
 *   builder_submit  Builder or architect sends Part 2 → answers are written into the SAME row,
 *                   builder_status becomes "Received", Greg and Rachel are emailed, and the
 *                   homeowner gets a short note that the answers arrived.
 *   save_draft / resume_draft  "Save & email link" for the homeowner, same as the other forms.
 *
 * ============================================================
 * DEPLOYMENT (one-time setup, ~5 minutes)
 * ============================================================
 *  1. Create a new blank Google Sheet named "TWB Spec Book Intake".
 *  2. In that sheet: Extensions → Apps Script. Delete the boilerplate and paste THIS entire file.
 *  3. Check the CONFIG block below (recipients and FORM_URL).
 *  4. Save. Run testSubmit once from the editor and authorize when prompted
 *     (Google will warn — Advanced → Go to … (unsafe). It is your script.).
 *     Confirm the test row appears and both emails arrive, then delete the test row.
 *  5. Deploy → New deployment → gear → Web app.
 *       Description: "TWB Spec Book Intake v1"   Execute as: Me   Who has access: Anyone
 *  6. Copy the Web app URL and paste it into APPS_SCRIPT_URL in index.html.
 *     (That also turns off draft mode in the form.)
 *
 * To update later: paste the new code, then Deploy → Manage deployments → pencil → New version → Deploy.
 * A NEW deployment gets a new URL and breaks the form.
 *
 * ============================================================
 * CONFIG
 * ============================================================
 */
const RECIPIENT_EMAIL = 'greg@thewellbuild.com,rachel@thewellbuild.com';
const FORM_URL        = 'https://specbook.thewellbuild.com';   // where index.html is hosted
const FORM_TITLE      = 'The Well Build — Spec Book Intake';
const BRAND_GREEN     = '#1E4430';
const BRAND_COPPER    = '#B07D4A';
const BRAND_CREAM     = '#FAF8F4';

const SHEET_RESPONSES = 'Responses';
const SHEET_DRAFTS    = 'Drafts';

const PART2_FORWARD   = 'Send them to my builder or architect';

// Column order in the Sheet. Meta first, then one column per question id (same ids as the form,
// and as plan-review-engine/standard/data/intake.json). A missing column is added automatically
// on the next submission, so adding a question to the form only needs its id added here.
const RESPONSE_COLUMNS = [
  // Meta
  'submitted_at', 'order', 'draftId', 'builder_token', 'builder_status', 'builder_submitted_at',
  // Your project
  'full_name', 'email_address', 'phone_number', 'address', 'project_type', 'year_built', 'existing_house',
  'design_stage', 'construction_stage', 'sq_ft', 'builder_status_answer', 'builder_name', 'architect_status',
  // Your drawings
  'drawings_method', 'drawings_link', 'geotech', 'geotech_link', 'builder_spec',
  // Your household
  'occupants_adults', 'occupants_children', 'occupants_child_ages', 'occupants_other', 'occupancy',
  'priorities', 'low_emf', 'health_sensitivity', 'chemical_sensitivity', 'accepts_foam', 'current_home', 'budget_posture',
  // Climate and water
  'microclimate', 'microclimate_other', 'fuel', 'water_source', 'water_test',
  // Exterior and windows
  'cladding', 'cladding_brands', 'roofing', 'roofing_brands', 'windows', 'window_frame', 'window_flange',
  // Your goals
  'top_concerns', 'part2_mode',
  // Part 2: who answered
  'part2_answered_by', 'builder_role', 'builder_contact_name', 'builder_company', 'builder_email',
  // Part 2: answers
  'foundation_type', 'below_grade', 'struct_type', 'sheathing_type', 'roof_underlayment',
  'insulation_walls', 'insulation_roof', 'insulation_foundation', 'attic_type',
  'hvac_type', 'manual_j', 'duct_location', 'ventilation', 'water_heater', 'pipe_material',
  // Notes (all "+ Add a note" text, one line per question) and backups
  'notes', 'raw_json', 'builder_raw_json'
];

// The form's builder_status question would collide with the meta column of the same name,
// so the homeowner's answer is stored as builder_status_answer.
const RENAMED = { builder_status: 'builder_status_answer' };

// Ids a builder submission is allowed to write (Part 2 only — it can't overwrite the homeowner's answers).
const BUILDER_IDS = [
  'builder_role', 'builder_contact_name', 'builder_company', 'builder_email',
  'foundation_type', 'below_grade', 'struct_type', 'sheathing_type', 'roof_underlayment',
  'insulation_walls', 'insulation_roof', 'insulation_foundation', 'attic_type',
  'hvac_type', 'manual_j', 'duct_location', 'ventilation', 'water_heater', 'pipe_material'
];

// ============================================================
// ENTRY POINT
// ============================================================
function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return jsonResponse({ ok: false, error: 'Invalid JSON' }); }
  try {
    switch (body.action) {
      case 'save_draft':     return jsonResponse(handleSaveDraft(body));
      case 'resume_draft':   return jsonResponse(handleResumeDraft(body));
      case 'submit':         return jsonResponse(withLock(function() { return handleSubmit(body); }));
      case 'builder_lookup': return jsonResponse(handleBuilderLookup(body));
      case 'builder_submit': return jsonResponse(withLock(function() { return handleBuilderSubmit(body); }));
      default:               return jsonResponse({ ok: false, error: 'Unknown action: ' + body.action });
    }
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet() {
  return jsonResponse({ ok: true, service: 'TWB Spec Book Intake backend',
    actions: ['save_draft', 'resume_draft', 'submit', 'builder_lookup', 'builder_submit'] });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ============================================================
// SHEET HELPERS
// ============================================================
function getOrCreateSheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground(BRAND_CREAM);
    sh.setFrozenRows(1);
    return sh;
  }
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const existing = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  const missing = headers.filter(function(h) { return existing.indexOf(h) < 0; });
  if (missing.length) {
    sh.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]).setFontWeight('bold').setBackground(BRAND_CREAM);
  }
  return sh;
}
function getResponsesSheet() { return getOrCreateSheet(SHEET_RESPONSES, RESPONSE_COLUMNS); }
function getDraftsSheet()    { return getOrCreateSheet(SHEET_DRAFTS, ['draftId', 'email', 'updated_at', 'submitted', 'payload_json']); }

function headersOf(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
}
function findRow(sheet, colName, value) {
  if (!value) return -1;
  const col = headersOf(sheet).indexOf(colName) + 1;
  if (col < 1 || sheet.getLastRow() < 2) return -1;
  const vals = sheet.getRange(2, col, sheet.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(value)) return i + 2;
  return -1;
}
function rowObject(sheet, row) {
  const h = headersOf(sheet);
  const v = sheet.getRange(row, 1, 1, h.length).getValues()[0];
  const o = {};
  h.forEach(function(k, i) { o[k] = v[i]; });
  return o;
}
function setCells(sheet, row, obj) {
  const h = headersOf(sheet);
  Object.keys(obj).forEach(function(k) {
    const col = h.indexOf(k) + 1;
    if (col > 0) sheet.getRange(row, col).setValue(obj[k]);
  });
}
function cellValue(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') {
    return Object.keys(v).filter(function(k) { return v[k]; }).map(function(k) { return k + ': ' + v[k]; }).join(' · ');
  }
  return v;
}
function newToken() { return Utilities.getUuid().replace(/-/g, '').slice(0, 16); }
function firstName(full) { return String(full || '').trim().split(/\s+/)[0] || ''; }
function builderUrl(token) { return FORM_URL + '/?builder=' + encodeURIComponent(token); }

// Notes: responses carry "<id>__note" keys. Collect them into one cell, one line per question.
function collectNotes(payload, onlyIds) {
  const lines = [];
  (payload.sections || []).forEach(function(s) {
    (s.items || []).forEach(function(it) {
      if (!it.note) return;
      if (onlyIds && onlyIds.indexOf(it.id) < 0) return;
      lines.push(it.label + ': ' + it.note);
    });
  });
  return lines.join('\n');
}

// ============================================================
// SAVE / RESUME DRAFT (homeowner only)
// ============================================================
function handleSaveDraft(body) {
  const sheet = getDraftsSheet();
  const email = String(body.email || '').trim();
  let draftId = body.draftId || Utilities.getUuid();
  const json = JSON.stringify(body.payload || {});
  const row = findRow(sheet, 'draftId', draftId);
  if (row > 0) sheet.getRange(row, 2, 1, 4).setValues([[email, new Date(), false, json]]);
  else sheet.appendRow([draftId, email, new Date(), false, json]);

  if (email) {
    try {
      const link = FORM_URL + '/?draft=' + encodeURIComponent(draftId);
      MailApp.sendEmail({ to: email, subject: 'Your Spec Book intake is saved', htmlBody: renderDraftEmail(link), name: 'The Well Build' });
    } catch (e) { Logger.log('Draft mail error: ' + e); }
  }
  return { ok: true, draftId: draftId };
}

function handleResumeDraft(body) {
  const sheet = getDraftsSheet();
  const row = findRow(sheet, 'draftId', body.draftId);
  if (row < 0) return { ok: false, error: 'Draft not found' };
  const d = sheet.getRange(row, 1, 1, 5).getValues()[0];
  if (d[3]) return { ok: false, error: 'This draft has already been submitted' };
  let payload = {};
  try { payload = JSON.parse(d[4] || '{}'); } catch (e) {}
  return { ok: true, payload: payload };
}

// ============================================================
// SUBMIT (homeowner)
// ============================================================
function handleSubmit(body) {
  const payload = body.payload || {};
  const r = payload.responses || {};
  const cover = payload.cover || {};
  const sheet = getResponsesSheet();

  const forwarding = r.part2_mode === PART2_FORWARD;
  const answeredNow = r.part2_mode && !forwarding;
  const token = forwarding ? newToken() : '';

  const meta = {
    submitted_at: new Date(),
    order: cover.order || '',
    draftId: body.draftId || '',
    builder_token: token,
    builder_status: forwarding ? 'Link sent to homeowner' : (answeredNow ? 'Answered with homeowner' : ''),
    part2_answered_by: answeredNow ? 'Homeowner, with builder or architect' : '',
    notes: collectNotes(payload),
    raw_json: JSON.stringify(payload)
  };

  const headers = headersOf(sheet);
  const row = headers.map(function(h) {
    if (meta.hasOwnProperty(h)) return meta[h];
    // Map renamed columns back to their form id
    let id = h;
    Object.keys(RENAMED).forEach(function(k) { if (RENAMED[k] === h) id = k; });
    return cellValue(r[id]);
  });
  sheet.appendRow(row);

  if (body.draftId) {
    const drafts = getDraftsSheet();
    const dr = findRow(drafts, 'draftId', body.draftId);
    if (dr > 0) drafts.getRange(dr, 4).setValue(true);
  }

  const link = token ? builderUrl(token) : '';

  // Team email (Reply-To the homeowner)
  try {
    const opts = {
      to: RECIPIENT_EMAIL,
      subject: '[Spec Book intake] ' + [cover.full_name, cover.address].filter(Boolean).join(' — '),
      htmlBody: renderSubmissionEmail(payload, { audience: 'team', builderLink: link }),
      name: 'TWB Spec Book Intake'
    };
    if (cover.email_address) opts.replyTo = cover.email_address;
    MailApp.sendEmail(opts);
  } catch (e) { Logger.log('Team mail error: ' + e); }

  // Homeowner confirmation (Reply-To Greg and Rachel)
  if (cover.email_address) {
    try {
      MailApp.sendEmail({
        to: cover.email_address,
        replyTo: RECIPIENT_EMAIL,
        subject: 'We have your Spec Book intake',
        htmlBody: renderSubmissionEmail(payload, { audience: 'homeowner', builderLink: link }),
        name: 'The Well Build'
      });
    } catch (e) { Logger.log('Homeowner mail error: ' + e); }
  }

  return { ok: true, builderUrl: link };
}

// ============================================================
// BUILDER LINK
// ============================================================
function handleBuilderLookup(body) {
  const sheet = getResponsesSheet();
  const row = findRow(sheet, 'builder_token', body.token);
  if (row < 0) return { ok: false, error: 'not_found' };
  const o = rowObject(sheet, row);
  return {
    ok: true,
    alreadySubmitted: !!o.builder_submitted_at,
    project: { address: o.address || '', client_first_name: firstName(o.full_name) }
  };
}

function handleBuilderSubmit(body) {
  const payload = body.payload || {};
  const r = payload.responses || {};
  const sheet = getResponsesSheet();
  const row = findRow(sheet, 'builder_token', body.token);
  if (row < 0) return { ok: false, error: 'not_found' };
  const o = rowObject(sheet, row);

  const updates = {};
  BUILDER_IDS.forEach(function(id) { updates[id] = cellValue(r[id]); });
  updates.builder_status = 'Received';
  updates.builder_submitted_at = new Date();
  updates.part2_answered_by = [r.builder_contact_name, r.builder_company].filter(Boolean).join(', ') + (r.builder_role ? ' (' + r.builder_role + ')' : '');
  updates.builder_raw_json = JSON.stringify(payload);
  const bNotes = collectNotes(payload, BUILDER_IDS);
  if (bNotes) updates.notes = [String(o.notes || ''), 'From the ' + String(r.builder_role || 'builder').toLowerCase() + ':', bNotes].filter(Boolean).join('\n');
  setCells(sheet, row, updates);

  const project = o.address || 'the project';
  const who = updates.part2_answered_by || 'The builder or architect';

  try {
    const opts = {
      to: RECIPIENT_EMAIL,
      subject: '[Spec Book intake] Builder answers in — ' + project,
      htmlBody: renderSubmissionEmail(payload, { audience: 'team-builder', project: project, homeowner: o.full_name }),
      name: 'TWB Spec Book Intake'
    };
    if (r.builder_email) opts.replyTo = r.builder_email;
    MailApp.sendEmail(opts);
  } catch (e) { Logger.log('Team builder mail error: ' + e); }

  if (o.email_address) {
    try {
      MailApp.sendEmail({
        to: String(o.email_address), replyTo: RECIPIENT_EMAIL, name: 'The Well Build',
        subject: 'Your builder\'s answers arrived',
        htmlBody: shell('Your builder\'s answers arrived',
          '<p>' + escapeHtml(who) + ' answered the technical questions for ' + escapeHtml(project) + '. You don\'t need to do anything else. We have what we need from your side, and we\'ll be in touch if anything in the drawings is unclear.</p>')
      });
    } catch (e) { Logger.log('Homeowner builder note error: ' + e); }
  }

  if (r.builder_email) {
    try {
      MailApp.sendEmail({
        to: r.builder_email, replyTo: RECIPIENT_EMAIL, name: 'The Well Build',
        subject: 'Your answers for ' + project,
        htmlBody: renderSubmissionEmail(payload, { audience: 'builder', project: project })
      });
    } catch (e) { Logger.log('Builder copy error: ' + e); }
  }

  return { ok: true };
}

// ============================================================
// EMAIL TEMPLATES
// ============================================================
function shell(title, inner) {
  return [
    '<div style="font-family:Helvetica,Arial,sans-serif;max-width:720px;margin:auto;padding:24px;background:' + BRAND_CREAM + ';color:#2A2A2A;line-height:1.5">',
    '<div style="font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:' + BRAND_COPPER + ';font-weight:bold">The Well Build</div>',
    '<h1 style="font-family:Georgia,serif;font-weight:normal;color:' + BRAND_GREEN + ';margin:8px 0 16px">' + escapeHtml(title) + '</h1>',
    inner,
    '<hr style="border:0;border-top:1px solid #C5D8CC;margin:28px 0 12px">',
    '<p style="font-size:12px;color:#6B6B6B">&copy; The Well Build&trade;</p>',
    '</div>'
  ].join('\n');
}

function button(href, label) {
  return '<p style="margin:20px 0"><a href="' + escapeHtml(href) + '" style="background:' + BRAND_GREEN + ';color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold">' + escapeHtml(label) + '</a></p>';
}

function renderDraftEmail(link) {
  return shell('Your answers are saved',
    '<p>Pick up where you left off any time.</p>' + button(link, 'Finish my intake →') +
    '<p style="font-size:13px;color:#6B6B6B">If the button doesn\'t work, paste this into your browser:<br><span style="word-break:break-all">' + escapeHtml(link) + '</span></p>');
}

function builderBlock(link) {
  const msg = 'Hi — I\'ve hired The Well Build to review our drawings and write material specifications. ' +
    'They have about 15 short questions only you can answer (foundation, walls, insulation, mechanical). ' +
    'It takes about 10 minutes and "Not decided" is fine for anything still open: ' + link;
  return [
    '<div style="background:#F1F6F2;border:1px solid #C5D8CC;border-radius:10px;padding:16px;margin:20px 0">',
    '<div style="font-weight:bold;color:' + BRAND_GREEN + ';margin-bottom:6px">Forward this link to your builder or architect</div>',
    '<p style="margin:0 0 8px">It opens their questions for your project, with no login. Their answers come straight to us, and we\'ll let you know when they arrive.</p>',
    '<p style="margin:0 0 12px;word-break:break-all"><a href="' + escapeHtml(link) + '">' + escapeHtml(link) + '</a></p>',
    '<div style="font-size:13px;color:#6B6B6B;margin-bottom:4px">A message you can copy:</div>',
    '<div style="background:#fff;border:1px solid #C5D8CC;border-radius:8px;padding:10px 12px;font-size:14px">' + escapeHtml(msg) + '</div>',
    '</div>'
  ].join('\n');
}

// Backup if the builder link doesn't work: the same questions as plain text to paste into an email.
function questionsBlock(text) {
  if (!text) return '';
  return [
    '<div style="border:1px dashed #C5D8CC;border-radius:10px;padding:16px;margin:0 0 20px">',
    '<div style="font-weight:bold;color:' + BRAND_GREEN + ';margin-bottom:6px">If the link doesn\'t work</div>',
    '<p style="margin:0 0 10px">Copy the questions below into an email to your builder or architect. When they reply, forward their answers to greg@thewellbuild.com.</p>',
    '<div style="background:#fff;border:1px solid #C5D8CC;border-radius:8px;padding:10px 12px;font-size:13px;white-space:pre-wrap;font-family:Helvetica,Arial,sans-serif">' + escapeHtml(text) + '</div>',
    '</div>'
  ].join('\n');
}

function answersTables(payload) {
  return (payload.sections || []).map(function(s) {
    if (s.skipped || !s.items || !s.items.length) return '';
    const rows = s.items.map(function(it) {
      const v = (it.display === '' || it.display == null) ? '<span style="color:#9CA8A0">&mdash;</span>' : escapeHtml(it.display);
      const note = it.note ? '<div style="color:#6B6B6B;font-size:13px;margin-top:4px">Note: ' + escapeHtml(it.note) + '</div>' : '';
      return '<tr><td style="padding:8px 12px;border-top:1px solid #EFEAE0;color:#6B6B6B;font-size:13px;vertical-align:top;width:45%">' + escapeHtml(it.label) +
        '</td><td style="padding:8px 12px;border-top:1px solid #EFEAE0;font-size:14px;vertical-align:top">' + v + note + '</td></tr>';
    }).join('\n');
    return '<h2 style="font-family:Georgia,serif;font-weight:normal;color:' + BRAND_GREEN + ';font-size:18px;margin:24px 0 8px">' + escapeHtml(s.title) + '</h2>' +
      '<table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #C5D8CC">' + rows + '</table>';
  }).join('\n');
}

function coverTable(rows) {
  return '<table style="width:100%;border-collapse:collapse;margin-bottom:8px;background:#fff;border:1px solid #C5D8CC">' +
    rows.filter(function(r) { return r[1]; }).map(function(r) {
      return '<tr><td style="padding:8px 12px;color:#6B6B6B;font-size:13px;width:160px;background:' + BRAND_CREAM + '">' + escapeHtml(r[0]) +
        '</td><td style="padding:8px 12px;font-size:14px">' + escapeHtml(r[1]) + '</td></tr>';
    }).join('') + '</table>';
}

function renderSubmissionEmail(payload, opts) {
  const c = payload.cover || {};
  const a = opts.audience;

  if (a === 'team') {
    const part2 = c.part2_mode === PART2_FORWARD
      ? 'Link sent to homeowner to forward' + (opts.builderLink ? ' (' + opts.builderLink + ')' : '')
      : (c.part2_mode ? 'Answered on this form' : '');
    return shell('New Spec Book intake',
      coverTable([
        ['Name', c.full_name], ['Email', c.email_address], ['Phone', c.phone_number], ['Order', c.order],
        ['Address', c.address], ['Project type', c.project_type], ['Drawings', c.drawings_method],
        ['Drawings link', c.drawings_link], ['Builder questions', part2]
      ]) +
      '<p style="font-size:13px;color:#6B6B6B">The review clock starts once the drawings are in hand. Reply to this email to reach the homeowner.</p>' +
      answersTables(payload));
  }
  if (a === 'homeowner') {
    const next = '<p>Thank you, ' + escapeHtml(firstName(c.full_name)) + '. Here\'s a copy of your answers. ' +
      'Next, we open your drawings and confirm we have what we need, or let you know what\'s missing. ' +
      'Your Spec Book typically arrives 7–10 business days after we have everything.</p>' +
      (c.drawings_method && /email|architect/i.test(c.drawings_method)
        ? '<p>If you haven\'t yet, send the drawings to greg@thewellbuild.com and rachel@thewellbuild.com with your project address in the subject line.</p>' : '');
    return shell('We have your answers', next + (opts.builderLink ? builderBlock(opts.builderLink) + questionsBlock(payload.part2_text) : '') + answersTables(payload) +
      '<p style="font-size:13px;color:#6B6B6B;margin-top:20px">Questions? Just reply to this email.</p>');
  }
  if (a === 'team-builder') {
    return shell('Builder answers in',
      coverTable([
        ['Project', opts.project], ['Homeowner', opts.homeowner],
        ['Answered by', [c.builder_contact_name, c.builder_company].filter(Boolean).join(', ')],
        ['Role', c.builder_role], ['Email', c.builder_email]
      ]) + '<p style="font-size:13px;color:#6B6B6B">Also written into the homeowner\'s row in the Sheet.</p>' + answersTables(payload));
  }
  // builder copy
  return shell('Your answers for ' + opts.project,
    '<p>Thank you. Here\'s a copy of what you sent. Anything marked Not decided goes into the review as an item to confirm.</p>' + answersTables(payload));
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ============================================================
// MANUAL TESTS (run from the Apps Script editor)
// testSubmit: homeowner submission that forwards the builder questions. Emails go to RECIPIENT_EMAIL only.
// testBuilderSubmit: answers for the most recent test row's builder link.
// Delete the test rows afterwards.
// ============================================================
function testSubmit() {
  const me = Session.getActiveUser().getEmail() || 'greg@thewellbuild.com';
  const payload = {
    mode: 'homeowner',
    cover: { full_name: 'Test Client', email_address: me, address: '123 Example Road, Nashville, TN', project_type: 'New home',
             drawings_method: 'WeTransfer', drawings_link: 'https://we.tl/example', part2_mode: PART2_FORWARD, order: '#TEST' },
    part2_text: 'Questions from The Well Build...\nFOUNDATION AND STRUCTURE\n- Foundation type: Basement / Slab on grade',
    responses: { full_name: 'Test Client', email_address: me, address: '123 Example Road, Nashville, TN', project_type: 'New home',
                 builder_status: 'Bidding', priorities: ['Moisture and mold', 'EMF mitigation'], low_emf: 'Medium',
                 cladding: ['Fiber cement', 'Natural stone'], cladding_brands: { 'Fiber cement': 'James Hardie' },
                 part2_mode: PART2_FORWARD },
    sections: [{ title: 'Your project', items: [{ label: 'Project address', display: '123 Example Road, Nashville, TN', note: '' }] }]
  };
  Logger.log(JSON.stringify(handleSubmit({ action: 'submit', payload: payload })));
}

function testBuilderSubmit() {
  const sheet = getResponsesSheet();
  const h = headersOf(sheet);
  const col = h.indexOf('builder_token');
  const data = sheet.getDataRange().getValues();
  let token = '';
  for (let i = data.length - 1; i > 0; i--) if (data[i][col]) { token = data[i][col]; break; }
  if (!token) { Logger.log('Run testSubmit first'); return; }
  const payload = {
    mode: 'builder',
    cover: { builder_role: 'Builder', builder_contact_name: 'Test Builder', builder_company: 'Example Homes' },
    responses: { builder_role: 'Builder', builder_contact_name: 'Test Builder', builder_company: 'Example Homes',
                 foundation_type: ['Basement'], attic_type: 'Not decided', hvac_type: ['Heat pump'] },
    sections: [{ title: 'Foundation and structure', items: [{ id: 'foundation_type', label: 'Foundation type', display: 'Basement', note: 'Walk-out on the east side' }] }]
  };
  Logger.log(JSON.stringify(handleBuilderSubmit({ action: 'builder_submit', token: token, payload: payload })));
}
