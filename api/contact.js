/* ==========================================================================
   Apex Construction — contact form endpoint

   Takes the enquiry from /contact.html and pushes it into GoHighLevel:
     1. upserts the person as a contact in the location
     2. writes the whole enquiry into a note on that contact

   Runs as a Vercel serverless function at POST /api/contact.
   No dependencies — global fetch, Node 18+.

   Handles two kinds of submit:
     - fetch() with JSON      → replies with JSON, form shows an inline message
     - plain form POST (no JS) → 303 back to /contact.html?enquiry=sent
   ========================================================================== */

'use strict';

const GHL_BASE = 'https://services.leadconnectorhq.com';
const GHL_VERSION = process.env.GHL_API_VERSION || '2021-07-28';

const FIELD_MAX = 300;    // one-line fields
const MESSAGE_MAX = 5000; // project details
const BODY_MAX = 100000;  // bytes accepted off the wire

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { ok: false, error: 'Method not allowed' });
  }

  const contentType = String(req.headers['content-type'] || '');
  // A plain HTML form post means JavaScript didn't run — reply with a redirect.
  const browserPost = contentType.includes('application/x-www-form-urlencoded');

  let body;
  try {
    body = await readBody(req, contentType);
  } catch (err) {
    console.error('[contact] could not read body:', err.message);
    return reply(res, browserPost, 400, { ok: false, error: 'Bad request' });
  }

  // Honeypot. Bots fill hidden fields, people never see them. Look successful,
  // do nothing — a bot that gets an error just tries again.
  if (trim(body.company)) return reply(res, browserPost, 200, { ok: true });

  const name = trim(body.name, FIELD_MAX);
  const email = trim(body.email, FIELD_MAX).toLowerCase();
  const phoneRaw = trim(body.phone, FIELD_MAX);
  const postcode = trim(body.postcode, FIELD_MAX).toUpperCase();
  const service = trim(body.service, FIELD_MAX);
  const message = trim(body.message, MESSAGE_MAX);
  const consent = /^(yes|on|true|1)$/i.test(trim(body.consent, 10));

  if (!name || (!email && !phoneRaw)) {
    return reply(res, browserPost, 422, {
      ok: false,
      error: 'Please give us your name and either a phone number or an email address.',
    });
  }

  const token = process.env.GHL_API_TOKEN;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!token || !locationId) {
    console.error('[contact] GHL_API_TOKEN / GHL_LOCATION_ID are not set — enquiry not saved.');
    return reply(res, browserPost, 500, { ok: false, error: unavailable() });
  }

  const country = (process.env.CONTACT_COUNTRY || 'GB').toUpperCase();
  const phone = toE164(phoneRaw, country);
  const [firstName, ...rest] = name.split(/\s+/);

  const tags = (process.env.GHL_TAGS || 'website-enquiry')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (service) tags.push(slug(service));

  const contact = {
    locationId,
    name,
    firstName,
    lastName: rest.join(' ') || undefined,
    email: email || undefined,
    phone: phone || undefined,
    postalCode: postcode || undefined,
    country,
    source: process.env.GHL_SOURCE || 'Website — Contact Form',
    tags,
  };
  if (process.env.GHL_ASSIGNED_USER_ID) contact.assignedTo = process.env.GHL_ASSIGNED_USER_ID;

  let contactId;
  try {
    const result = await ghl('/contacts/upsert', contact, token);
    contactId = (result.contact && result.contact.id) || result.id;
    if (!contactId) throw new Error('no contact id in the upsert response');
  } catch (err) {
    console.error('[contact] contact upsert failed:', err.message);
    return reply(res, browserPost, 502, { ok: false, error: unavailable() });
  }

  // The note is where the enquiry actually lives — the contact record has no
  // room for the project details.
  let noted = true;
  try {
    await ghl(`/contacts/${contactId}/notes`, {
      body: noteBody({
        name,
        phone: phoneRaw,
        phoneE164: phone,
        email,
        postcode,
        service,
        message,
        consent,
        page: trim(body.page, FIELD_MAX),
        referrer: trim(body.referrer, FIELD_MAX),
        campaign: trim(body.campaign, FIELD_MAX),
      }),
    }, token);
  } catch (err) {
    // The contact is in GHL, so the lead isn't lost — but the detail is.
    noted = false;
    console.error(`[contact] note failed for contact ${contactId}:`, err.message);
  }

  return reply(res, browserPost, 200, { ok: true, noted });
};

/* === GoHighLevel ========================================================== */

async function ghl(path, payload, token) {
  const response = await fetch(`${GHL_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Version: GHL_VERSION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* GHL returned HTML */ }

  if (!response.ok) {
    const detail = (data && (data.message || data.error)) || text.slice(0, 300);
    throw new Error(`${path} → ${response.status} ${detail}`);
  }
  return data || {};
}

function noteBody(e) {
  const stamp = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date());

  const lines = [
    'WEBSITE ENQUIRY — contact form',
    `Received: ${stamp}`,
    '',
    `Name:     ${e.name}`,
    `Phone:    ${e.phone || '—'}${e.phoneE164 && e.phoneE164 !== e.phone ? ` (${e.phoneE164})` : ''}`,
    `Email:    ${e.email || '—'}`,
    `Postcode: ${e.postcode || '—'}`,
    `Service:  ${e.service || '—'}`,
    '',
    'PROJECT DETAILS',
    e.message || '(none given)',
    '',
    `Consent:  ${e.consent ? 'Yes — happy to be contacted about this enquiry' : 'Not ticked'}`,
  ];

  if (e.page) lines.push(`Page:     ${e.page}`);
  if (e.referrer) lines.push(`Came from: ${e.referrer}`);
  if (e.campaign) lines.push(`Campaign: ${e.campaign}`);

  return lines.join('\n');
}

/* === Request / response =================================================== */

async function readBody(req, contentType) {
  if (req.body && typeof req.body === 'object') return req.body; // Vercel pre-parsed it

  const raw = typeof req.body === 'string' ? req.body : await rawText(req);
  if (!raw) return {};

  if (contentType.includes('application/json')) {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function rawText(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > BODY_MAX) {
        req.destroy();
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function reply(res, browserPost, status, payload) {
  if (!browserPost) return json(res, status, payload);
  return redirect(res, `/contact.html?enquiry=${payload.ok ? 'sent' : 'error'}#enquiry`);
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function redirect(res, location) {
  res.statusCode = 303;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

/* === Small helpers ======================================================== */

function trim(value, max) {
  if (typeof value !== 'string') return '';
  const out = value.trim();
  return max ? out.slice(0, max) : out;
}

// UK numbers get typed as 07588 539871 — GHL wants E.164.
function toE164(raw, country) {
  const cleaned = raw.replace(/[^\d+]/g, '');
  if (!cleaned) return '';
  if (cleaned.startsWith('+')) return cleaned;
  if (country === 'GB') {
    if (cleaned.startsWith('44')) return `+${cleaned}`;
    if (cleaned.startsWith('0')) return `+44${cleaned.slice(1)}`;
  }
  return cleaned;
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function unavailable() {
  return "Sorry — we couldn't send that just now. Please call 07588 539871 or email apexconstructionsouth@gmail.com.";
}
