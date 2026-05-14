/**
 * POST /api/book-appointment
 *
 * Creates a calendar appointment in Odoo via XML-RPC.
 * Body: { name, email, phone, company, slotISO, slotTime24, service }
 *   slotISO     — 'YYYY-MM-DD' in SGT
 *   slotTime24  — 'HH:MM' in SGT (e.g. '09:00', '14:00')
 */

const SLOT_DURATION_HOURS = 1;

// ── Minimal XML-RPC client ────────────────────────────────────────────────────

function toXml(val) {
  if (val === null || val === undefined) return '<value><boolean>0</boolean></value>';
  if (typeof val === 'boolean')          return `<value><boolean>${val?1:0}</boolean></value>`;
  if (typeof val === 'number' && Number.isInteger(val)) return `<value><int>${val}</int></value>`;
  if (typeof val === 'number')           return `<value><double>${val}</double></value>`;
  if (typeof val === 'string') {
    const e = val.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<value><string>${e}</string></value>`;
  }
  if (Array.isArray(val)) {
    return `<value><array><data>${val.map(toXml).join('')}</data></array></value>`;
  }
  if (typeof val === 'object') {
    const m = Object.entries(val)
      .map(([k,v]) => `<member><name>${k}</name>${toXml(v)}</member>`)
      .join('');
    return `<value><struct>${m}</struct></value>`;
  }
  return `<value><string>${String(val)}</string></value>`;
}

function buildCall(method, params) {
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${
    params.map(p => `<param>${toXml(p)}</param>`).join('')
  }</params></methodCall>`;
}

function parseVal(s) {
  s = s.trim();
  let m;
  if ((m = s.match(/^<(?:int|i4|i8)>([\s\S]*?)<\/(?:int|i4|i8)>$/))) return parseInt(m[1], 10);
  if ((m = s.match(/^<boolean>([\s\S]*?)<\/boolean>$/)))               return m[1].trim() === '1';
  if ((m = s.match(/^<string>([\s\S]*?)<\/string>$/s)))
    return m[1].replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
  if ((m = s.match(/^<double>([\s\S]*?)<\/double>$/)))                 return parseFloat(m[1]);
  if ((m = s.match(/^<array>\s*<data>([\s\S]*?)<\/data>\s*<\/array>$/s))) return parseArray(m[1]);
  if ((m = s.match(/^<struct>([\s\S]*?)<\/struct>$/s)))                return parseStruct(m[1]);
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
}

function parseArray(inner) {
  const items = [];
  let depth = 0, start = -1, i = 0;
  while (i < inner.length) {
    if (inner.startsWith('<value>', i))  { if (depth++ === 0) start = i + 7; i += 7; }
    else if (inner.startsWith('</value>', i)) {
      if (--depth === 0 && start >= 0) { items.push(parseVal(inner.slice(start, i).trim())); start = -1; }
      i += 8;
    } else { i++; }
  }
  return items;
}

function parseStruct(inner) {
  const obj = {};
  const re = /<member>\s*<name>([\s\S]*?)<\/name>\s*<value>([\s\S]*?)<\/value>\s*<\/member>/g;
  let m;
  while ((m = re.exec(inner)) !== null) obj[m[1]] = parseVal(m[2].trim());
  return obj;
}

function parseResponse(xml) {
  if (/<fault>/.test(xml)) {
    const m = xml.match(/<name>faultString<\/name>\s*<value>\s*<string>([\s\S]*?)<\/string>/);
    throw new Error(m ? m[1] : 'XML-RPC fault');
  }
  const m = xml.match(/<params>\s*<param>\s*<value>([\s\S]*?)<\/value>\s*<\/param>\s*<\/params>/s);
  if (!m) throw new Error('Invalid XML-RPC response');
  return parseVal(m[1].trim());
}

async function rpc(url, method, params) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body: buildCall(method, params)
  });
  return parseResponse(await resp.text());
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const pad = n => String(n).padStart(2, '0');

// Convert SGT date+time → Odoo UTC datetime string
function toOdooUTC(dateISO, time24) {
  const [y, mo, d]  = dateISO.split('-').map(Number);
  const [hh, mm]    = time24.split(':').map(Number);
  // SGT = UTC+8, so subtract 8 hours
  const utc = new Date(Date.UTC(y, mo-1, d, hh - 8, mm, 0));
  return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth()+1)}-${pad(utc.getUTCDate())} ` +
         `${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}:00`;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { name, email, phone, company, slotISO, slotTime24, service } = req.body || {};
  if (!name || !email || !slotISO || !slotTime24)
    return res.status(400).json({ error: 'name, email, slotISO and slotTime24 are required' });

  const ODOO_URL     = process.env.ODOO_URL;
  const ODOO_DB      = process.env.ODOO_DB;
  const ODOO_USER    = process.env.ODOO_USER;
  const ODOO_API_KEY = process.env.ODOO_API_KEY;
  const APPT_TYPE_ID = parseInt(process.env.ODOO_APPT_TYPE_ID || '2', 10);

  if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_API_KEY)
    return res.status(500).json({ error: 'Odoo env vars not configured' });

  try {
    /* ── Step 1: Authenticate as sky@technext.asia ── */
    const uid = await rpc(`${ODOO_URL}/xmlrpc/2/common`, 'authenticate',
      [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}]);
    if (!uid || uid === false)
      return res.status(401).json({ error: 'Odoo authentication failed' });

    /* ── Step 1b: Get sky's partner_id so she appears as the organiser ── */
    const skyUser = await rpc(`${ODOO_URL}/xmlrpc/2/object`, 'execute_kw', [
      ODOO_DB, uid, ODOO_API_KEY,
      'res.users', 'read',
      [[uid]],
      { fields: ['partner_id'] }
    ]);
    const skyPartnerId = Array.isArray(skyUser) && skyUser[0] && skyUser[0].partner_id
      ? (Array.isArray(skyUser[0].partner_id) ? skyUser[0].partner_id[0] : skyUser[0].partner_id)
      : false;

    /* ── Step 2: Find or create the customer partner ── */
    let partnerId = false;
    const existing = await rpc(`${ODOO_URL}/xmlrpc/2/object`, 'execute_kw', [
      ODOO_DB, uid, ODOO_API_KEY,
      'res.partner', 'search_read',
      [[['email', '=', email]]],
      { fields: ['id'], limit: 1 }
    ]);
    if (Array.isArray(existing) && existing.length > 0) {
      partnerId = existing[0].id;
    } else {
      partnerId = await rpc(`${ODOO_URL}/xmlrpc/2/object`, 'execute_kw', [
        ODOO_DB, uid, ODOO_API_KEY,
        'res.partner', 'create',
        [{
          name:  name,
          email: email,
          phone: phone || '',
          ...(company ? { company_name: company } : {})
        }]
      ]);
    }

    /* ── Step 3: Build datetimes in UTC ── */
    const startUTC = toOdooUTC(slotISO, slotTime24);
    const [hh, mm] = slotTime24.split(':').map(Number);
    const stopUTC  = toOdooUTC(slotISO,
      `${pad(hh + SLOT_DURATION_HOURS)}:${pad(mm)}`);

    /* ── Step 4: Create calendar event owned by sky ── */
    const description = [
      service ? `Service interest: ${service}` : '',
      phone   ? `Phone: ${phone}`               : '',
      company ? `Company: ${company}`           : ''
    ].filter(Boolean).join('\n');

    // Build attendee list: always include sky + the customer
    const attendees = [[4, partnerId]];
    if (skyPartnerId && skyPartnerId !== partnerId) attendees.push([4, skyPartnerId]);

    const eventId = await rpc(`${ODOO_URL}/xmlrpc/2/object`, 'execute_kw', [
      ODOO_DB, uid, ODOO_API_KEY,
      'calendar.event', 'create',
      [{
        name:                `Demo — ${name}${company ? ` (${company})` : ''}`,
        start:               startUTC,
        stop:                stopUTC,
        appointment_type_id: APPT_TYPE_ID,
        description:         description,
        user_id:             uid,          // sky is the organiser
        partner_ids:         attendees,    // sky + customer as attendees
        active:              true
      }]
    ]);

    return res.status(200).json({ success: true, event_id: eventId });

  } catch (err) {
    console.error('book-appointment error:', err);
    return res.status(500).json({ error: err.message });
  }
}
