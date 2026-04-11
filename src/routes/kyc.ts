import { Router, Request, Response } from 'express';
import axios, { AxiosError } from 'axios';
import {
  getPersonaKycByReference,
  inferPersonaVerified,
  normalizePersonaReferenceId,
  updatePersonaKycByInquiry,
  upsertPersonaKyc,
} from '../db';

const router = Router();

const PERSONA_BASE = 'https://api.withpersona.com/api/v1';
const PERSONA_VERSION = process.env.PERSONA_API_VERSION || '2025-10-27';

function personaHeaders(): Record<string, string> {
  const key = process.env.PERSONA_API_KEY;
  if (!key) throw new Error('PERSONA_API_KEY missing');
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
    'Persona-Version': PERSONA_VERSION,
  };
}

/**
 * Persona puts the JWT in `meta.session-token` for resume responses; create-inquiry may use `included` or `meta`.
 * @see https://docs.withpersona.com/resuming-inquiries
 */
function extractSessionTokenFromMeta(payload: Record<string, unknown>): string | undefined {
  const meta = payload.meta;
  if (!meta || typeof meta !== 'object') return undefined;
  const m = meta as Record<string, unknown>;
  const st = m['session-token'] ?? m.sessionToken;
  return typeof st === 'string' && st.length > 0 ? st : undefined;
}

function extractSessionTokenFromIncluded(payload: Record<string, unknown>): string | undefined {
  const included = payload?.included;
  if (!Array.isArray(included)) return undefined;
  for (const item of included) {
    if (!item || typeof item !== 'object') continue;
    const type = (item as { type?: string }).type;
    if (type !== 'inquiry-session') continue;
    const attrs = (item as { attributes?: Record<string, unknown> }).attributes;
    if (!attrs) continue;
    const st =
      (attrs['session-token'] as string) ||
      (attrs.sessionToken as string) ||
      (attrs['one-time-link-token'] as string);
    if (typeof st === 'string' && st.length > 0) return st;
  }
  return undefined;
}

function extractAnySessionToken(payload: Record<string, unknown>): string | undefined {
  return extractSessionTokenFromMeta(payload) ?? extractSessionTokenFromIncluded(payload);
}

function personaErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const ax = err as AxiosError<{ errors?: Array<{ title?: string; detail?: string }> }>;
    const data = ax.response?.data;
    const first = data?.errors?.[0];
    const detail = first?.detail || first?.title;
    if (detail) return detail;
    if (typeof ax.response?.data === 'string') return ax.response.data;
    return ax.message;
  }
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}

/** Mobile SDK needs a session token from `meta` — create-inquiry often omits it; resume supplies it. */
async function ensureMobileSessionToken(inquiryId: string): Promise<string | undefined> {
  try {
    const { data } = await axios.post<Record<string, unknown>>(
      `${PERSONA_BASE}/inquiries/${inquiryId}/resume`,
      {},
      { headers: personaHeaders() }
    );
    return extractAnySessionToken(data);
  } catch (err) {
    console.warn('[KYC] POST /inquiries/.../resume failed:', personaErrorMessage(err));
    return undefined;
  }
}

/** Create a Persona inquiry (server-side). Mobile SDK opens it via inquiry id. */
router.post('/persona/inquiry', async (req: Request, res: Response) => {
  try {
    if (!process.env.PERSONA_API_KEY) {
      res.status(503).json({ error: 'Persona API key not configured' });
      return;
    }
    const templateId = process.env.PERSONA_INQUIRY_TEMPLATE_ID;
    if (!templateId || templateId.includes('REPLACE')) {
      res.status(503).json({
        error:
          'Set PERSONA_INQUIRY_TEMPLATE_ID in backend .env to your inquiry template id (itmpl_...) from the Persona dashboard.',
      });
      return;
    }
    if (
      !templateId.startsWith('itmpl_') &&
      !templateId.startsWith('tmpl_')
    ) {
      res.status(400).json({
        error:
          `Invalid PERSONA_INQUIRY_TEMPLATE_ID "${templateId}". Expected a template id starting with "itmpl_" or "tmpl_". ` +
          'Do not use an inquiry id (starts with "inq_").',
      });
      return;
    }

    const rawRef =
      (typeof req.body?.referenceId === 'string' && req.body.referenceId.trim()) || undefined;
    const referenceId = normalizePersonaReferenceId(rawRef);

    /** Optional: pin the visual design from the dashboard (see Persona “Inquiry Theming”). */
    const themeSetId = process.env.PERSONA_INQUIRY_THEME_SET_ID?.trim();
    const legacyThemeId = process.env.PERSONA_INQUIRY_THEME_ID?.trim();

    const attributes: Record<string, string | boolean> = {
      'auto-create-inquiry-session': true,
    };
    if (templateId.startsWith('tmpl_')) {
      attributes['template-id'] = templateId;
    } else {
      attributes['inquiry-template-id'] = templateId;
    }
    if (referenceId) {
      attributes['reference-id'] = referenceId;
    }
    // Dynamic inquiry templates (itmpl_): use theme-set-id. Legacy (tmpl_): use theme-id — not both.
    if (templateId.startsWith('itmpl_') && themeSetId) {
      attributes['theme-set-id'] = themeSetId;
    } else if (templateId.startsWith('tmpl_') && legacyThemeId) {
      attributes['theme-id'] = legacyThemeId;
    }

    const { data: payload } = await axios.post(
      `${PERSONA_BASE}/inquiries`,
      {
        data: {
          attributes,
        },
      },
      { headers: personaHeaders() }
    );

    const body = payload as Record<string, unknown>;
    const inquiryData = body?.data as { id?: string } | undefined;
    const inquiryId = inquiryData?.id;
    if (!inquiryId) {
      res.status(502).json({ error: 'Persona response missing inquiry id', raw: body });
      return;
    }

    let sessionToken = extractAnySessionToken(body);
    if (!sessionToken) {
      sessionToken = await ensureMobileSessionToken(inquiryId);
    }
    if (!sessionToken) {
      console.warn('[KYC] No session token from create or resume — mobile SDK may behave incorrectly');
    }

    if (referenceId) {
      upsertPersonaKyc({
        referenceId,
        inquiryId,
        status: 'created',
        verified: inferPersonaVerified('created'),
      });
    }

    res.status(201).json({
      inquiryId,
      sessionToken: sessionToken ?? null,
      referenceId: referenceId ?? null,
    });
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status ?? 500 : 500;
    console.error('[KYC] create inquiry failed:', personaErrorMessage(err));
    res.status(status >= 400 && status < 600 ? status : 500).json({
      error: personaErrorMessage(err),
    });
  }
});

/** Fetch inquiry status for Settings / polling after the user finishes the flow. */
router.get('/persona/inquiry/:inquiryId', async (req: Request, res: Response) => {
  try {
    if (!process.env.PERSONA_API_KEY) {
      res.status(503).json({ error: 'Persona API key not configured' });
      return;
    }
    const rawId = req.params.inquiryId;
    const inquiryId = typeof rawId === 'string' ? rawId : rawId?.[0];
    if (!inquiryId || !inquiryId.startsWith('inq_')) {
      res.status(400).json({ error: 'Invalid inquiry id' });
      return;
    }

    const { data: payload } = await axios.get(`${PERSONA_BASE}/inquiries/${inquiryId}`, {
      headers: personaHeaders(),
    });

    const body = payload as Record<string, unknown>;
    const data = body?.data as {
      id?: string;
      attributes?: Record<string, unknown>;
    } | undefined;

    const attrs = data?.attributes ?? {};
    const status = (attrs.status as string) || 'unknown';

    updatePersonaKycByInquiry(inquiryId, status, inferPersonaVerified(status));

    res.json({
      inquiryId: data?.id ?? inquiryId,
      status,
      attributes: attrs,
    });
  } catch (err) {
    const status = axios.isAxiosError(err) ? err.response?.status ?? 500 : 500;
    console.error('[KYC] get inquiry failed:', personaErrorMessage(err));
    res.status(status >= 400 && status < 600 ? status : 500).json({
      error: personaErrorMessage(err),
    });
  }
});

/**
 * Stored KYC row for a user (by Persona reference-id / Privy id).
 * Query: referenceId — same string the app sends when creating an inquiry (DID ok).
 * refresh=1 — re-fetch status from Persona for the stored inquiry id, then update DB.
 */
router.get('/persona/status', async (req: Request, res: Response) => {
  try {
    const rawRef = typeof req.query.referenceId === 'string' ? req.query.referenceId.trim() : '';
    const referenceId = normalizePersonaReferenceId(rawRef || undefined);
    if (!referenceId) {
      res.status(400).json({ error: 'Missing referenceId query parameter' });
      return;
    }

    let row = getPersonaKycByReference(referenceId);
    const refresh =
      req.query.refresh === '1' ||
      req.query.refresh === 'true' ||
      req.query.refresh === 'yes';

    if (refresh && row?.inquiry_id && process.env.PERSONA_API_KEY) {
      try {
        const { data: payload } = await axios.get(
          `${PERSONA_BASE}/inquiries/${row.inquiry_id}`,
          { headers: personaHeaders() }
        );
        const body = payload as Record<string, unknown>;
        const data = body?.data as { id?: string; attributes?: Record<string, unknown> } | undefined;
        const attrs = data?.attributes ?? {};
        const status = (attrs.status as string) || row.status;
        const inq = data?.id ?? row.inquiry_id;
        upsertPersonaKyc({
          referenceId,
          inquiryId: inq,
          status,
          verified: inferPersonaVerified(status),
        });
        row = getPersonaKycByReference(referenceId);
      } catch (err) {
        console.warn('[KYC] refresh persona status failed:', personaErrorMessage(err));
      }
    }

    if (!row) {
      res.json({
        referenceId,
        inquiryId: null,
        status: null,
        verified: false,
        updatedAt: null,
      });
      return;
    }

    res.json({
      referenceId: row.reference_id,
      inquiryId: row.inquiry_id,
      status: row.status,
      verified: row.verified === 1,
      updatedAt: row.updated_at,
    });
  } catch (err) {
    console.error('[KYC] persona/status failed:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

export default router;
