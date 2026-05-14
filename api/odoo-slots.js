/**
 * GET /api/odoo-slots?year=YYYY&month=M
 *
 * Returns booked appointment slots from Odoo for the given month.
 * Uses XML-RPC (API-key compatible) instead of session auth.
 * Slots are expressed as 'YYYY-MM-DD_HH:MM' strings in SGT (UTC+8).
 */

const BK_TIMES_24 = ['09:00','10:00','11:00','14:00','15:00','16:00'];

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

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const { year, month } = req.query || {};
  if (!year || !month) return res.status(400).json({ error: 'year and month are required' });

  const ODOO_URL     = process.env.ODOO_URL;
  const ODOO_DB      = process.env.ODOO_DB;
  const ODOO_USER    = process.env.ODOO_USER;
  const ODOO_API_KEY = process.env.ODOO_API_KEY;
  const APPT_TYPE_ID = parseInt(process.env.ODOO_APPT_TYPE_ID || '2', 10);

  if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_API_KEY)
    return res.status(500).json({ error: 'Odoo env vars not configured' });

  const yr = parseInt(year,  10);
  const mo = parseInt(month, 10);

  const startUTC = new Date(Date.UTC(yr, mo-1, 1, 0,0,0) - 8*3600*1000);
  const endUTC   = new Date(Date.UTC(yr, mo,   1, 0,0,0) + 16*3600*1000);
  const pad = n => String(n).padStart(2,'0');
  const fmtUTC = d =>
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;

  try {
    /* ── Step 1: Authenticate via XML-RPC ── */
    const uid = await rpc(`${ODOO_URL}/xmlrpc/2/common`, 'authenticate',
      [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}]);

    if (!uid || uid === false) {
      return res.status(401).json({ error: 'Odoo authentication failed' });
    }

    /* ── Step 2: Fetch booked calendar events ── */
    const events = await rpc(`${ODOO_URL}/xmlrpc/2/object`, 'execute_kw', [
      ODOO_DB, uid, ODOO_API_KEY,
      'calendar.event', 'search_read',
      [[
        ['appointment_type_id', '=', APPT_TYPE_ID],
        ['start', '>=', fmtUTC(startUTC)],
        ['start', '<',  fmtUTC(endUTC)],
        ['active', '=', true]
      ]],
      { fields: ['start', 'stop', 'name'], limit: 500 }
    ]);

    /* ── Step 3: Convert events → blocked slot keys ── */
    const SGT = 8 * 3600 * 1000;
    const bookedSet = new Set();

    for (const evt of (Array.isArray(events) ? events : [])) {
      const startSGT = new Date(new Date(evt.start.replace(' ','T')+'Z').getTime() + SGT);
      const stopSGT  = new Date(new Date(evt.stop.replace(' ','T') +'Z').getTime() + SGT);

      const dateStr = `${startSGT.getUTCFullYear()}-` +
                      `${pad(startSGT.getUTCMonth()+1)}-` +
                      `${pad(startSGT.getUTCDate())}`;

      const evtStartMin = startSGT.getUTCHours()*60 + startSGT.getUTCMinutes();
      const evtStopMin  = stopSGT.getUTCHours() *60 + stopSGT.getUTCMinutes();

      for (const t of BK_TIMES_24) {
        const [hh, mm]   = t.split(':').map(Number);
        const slotStart  = hh*60 + mm;
        const slotStop   = slotStart + 60;
        if (slotStart < evtStopMin && slotStop > evtStartMin)
          bookedSet.add(`${dateStr}_${t}`);
      }
    }

    /* ── Step 4: Return ── */
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.status(200).json({ booked: [...bookedSet] });

  } catch (err) {
    console.error('odoo-slots error:', err);
    return res.status(500).json({ error: err.message });
  }
}
