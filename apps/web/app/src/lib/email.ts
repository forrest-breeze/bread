function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getReplyToAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1].trim() : from.trim();
}


interface InviteEmailParams {
  to: string;
  workspaceName: string;
  inviterName: string;
  role: string;
  joinUrl: string;
}

interface ResendErrorBody {
  message?: string;
  name?: string;
}

export async function sendInviteEmail({
  to,
  workspaceName,
  inviterName,
  role,
  joinUrl,
}: InviteEmailParams): Promise<{ success: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[Bread] RESEND_API_KEY not set — skipping invite email");
    return { success: false, error: "Email not configured" };
  }

  const from = process.env.RESEND_FROM_ADDRESS;
  if (!from) {
    console.warn("[Bread] RESEND_FROM_ADDRESS not set — skipping invite email");
    return { success: false, error: "Email not configured" };
  }

  const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="font-size: 18px; font-weight: 600; margin-bottom: 8px;">You've been invited to ${workspaceName}</h2>
        <p style="color: #6b7280; font-size: 14px; line-height: 1.6; margin-bottom: 24px;">
          ${inviterName} invited you to join <strong>${workspaceName}</strong> as a <strong>${role}</strong> on Bread.
        </p>
        <a href="${joinUrl}" style="display: inline-block; background: #171717; color: #fff; padding: 10px 24px; border-radius: 6px; font-size: 14px; font-weight: 500; text-decoration: none;">
          Accept Invite
        </a>
        <p style="color: #9ca3af; font-size: 12px; margin-top: 32px;">
          If you weren't expecting this invite, you can ignore this email.
        </p>
      </div>
    `;

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to,
        subject: `${inviterName} invited you to ${workspaceName} on Bread`,
        html,
        reply_to: getReplyToAddress(from),
      }),
    });

    if (!response.ok) {
      let message = response.statusText;
      try {
        const body = (await response.json()) as ResendErrorBody;
        if (body.message) message = body.message;
      } catch {}
      console.error("[Bread] Failed to send invite email:", message);
      return { success: false, error: message };
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Bread] Failed to send invite email:", message);
    return { success: false, error: message };
  }
}

interface DemoRequestNotificationParams {
  name: string | null;
  email: string;
  teamSize: string;
  companyName: string | null;
  interestedReason: string | null;
  additionalNotes?: string | null;
}

export async function sendDemoRequestNotificationEmail({
  name,
  email,
  teamSize,
  companyName,
  interestedReason,
  additionalNotes,
}: DemoRequestNotificationParams): Promise<{ success: boolean; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[Bread] RESEND_API_KEY not set — skipping demo request notification email");
    return { success: false, error: "Email not configured" };
  }

  const from = process.env.RESEND_FROM_ADDRESS;
  if (!from) {
    console.warn("[Bread] RESEND_FROM_ADDRESS not set — skipping demo request notification email");
    return { success: false, error: "Email not configured" };
  }

  const to = process.env.DEMO_REQUEST_NOTIFY_EMAIL;
  if (!to) {
    console.warn("[Bread] DEMO_REQUEST_NOTIFY_EMAIL not set — skipping demo request notification email");
    return { success: false, error: "Notify email not configured" };
  }

  const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="font-size: 18px; font-weight: 600; margin-bottom: 8px;">New demo request — ${escapeHtml(companyName ?? email)}</h2>
        <p style="color: #6b7280; font-size: 14px; line-height: 1.6; margin-bottom: 16px;">
          <strong>${escapeHtml(name ?? email)}</strong> (<a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>) — ${teamSize !== "individual" ? `${escapeHtml(teamSize)} people.` : "Individual request."}
        </p>
        ${interestedReason ? `<p style="color: #171717; font-size: 14px; line-height: 1.6; margin-bottom: 16px;">
          <strong>Why interested:</strong><br />${escapeHtml(interestedReason)}
        </p>` : ""}
        ${
          additionalNotes
            ? `<p style="color: #171717; font-size: 14px; line-height: 1.6; margin-bottom: 16px;"><strong>Notes:</strong><br />${escapeHtml(additionalNotes)}</p>`
            : ""
        }
        <a href="${process.env.NEXT_PUBLIC_APP_URL ?? ""}/ops/demo-requests" style="display: inline-block; background: #171717; color: #fff; padding: 10px 24px; border-radius: 6px; font-size: 14px; font-weight: 500; text-decoration: none;">
          View in ops
        </a>
      </div>
    `;

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to,
        subject: `New demo request — ${companyName ?? email}`,
        html,
        reply_to: getReplyToAddress(from),
      }),
    });

    if (!response.ok) {
      let message = response.statusText;
      try {
        const body = (await response.json()) as ResendErrorBody;
        if (body.message) message = body.message;
      } catch {}
      console.error("[Bread] Failed to send demo request notification email:", message);
      return { success: false, error: message };
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Bread] Failed to send demo request notification email:", message);
    return { success: false, error: message };
  }
}
