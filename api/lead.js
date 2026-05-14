/**
 * POST /api/lead
 * Creates a CRM lead in Odoo using XML-RPC (API-key compatible).
 */

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
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { name, phone, email, company, message, service } = req.body || {};
  const ODOO_URL     = process.env.ODOO_URL;
  const ODOO_DB      = process.env.ODOO_DB;
  const ODOO_USER    = process.env.ODOO_USER;
  const ODOO_API_KEY = process.env.ODOO_API_KEY;

  if (!ODOO_URL || !ODOO_DB || !ODOO_USER || !ODOO_API_KEY)
    return res.status(500).json({ error: 'Odoo env vars not configured' });

  try {
    /* Step 1: Authenticate via XML-RPC */
    const uid = await rpc(`${ODOO_URL}/xmlrpc/2/common`, 'authenticate',
      [ODOO_DB, ODOO_USER, ODOO_API_KEY, {}]);

    if (!uid || uid === false)
      return res.status(401).json({ error: 'Odoo authentication failed' });

    /* Step 2: Create CRM lead */
    const leadName  = `Demo Request — ${name}${company ? ` (${company})` : ''}`;
    const description = [
      service ? `Service: ${service}` : '',
      phone   ? `Phone: ${phone}`     : '',
      email   ? `Email: ${email}`     : '',
      message ? `Challenge: ${message}` : ''
    ].filter(Boolean).join('\n');

    const leadId = await rpc(`${ODOO_URL}/xmlrpc/2/object`, 'execute_kw', [
      ODOO_DB, uid, ODOO_API_KEY,
      'crm.lead', 'create',
      [{
        name:         leadName,
        contact_name: name    || '',
        email_from:   email   || '',
        phone:        phone   || '',
        partner_name: company || '',
        description:  description,
        type:         'lead'
      }]
    ]);

    return res.status(200).json({ success: true, lead_id: leadId });

  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({ error: err.message });
  }
}
