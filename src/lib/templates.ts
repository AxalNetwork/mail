export interface MailTemplate {
  name: string;
  meta: string;
  subject: string;
  html: string;
}

/** Approved firm templates. Bracketed text is for the sender to replace. */
export const TEMPLATES: MailTemplate[] = [
  {
    name: 'Founder inquiry acknowledgement', meta: 'Approved by Partners · founders', subject: 'Thank you for reaching out to Axal VC',
    html: '<p>Hi [first name],</p><p>Thank you for sharing [company] with us. A member of the team will review your materials and reply within five business days with next steps.</p><p>Best regards,</p>'
  },
  {
    name: 'Meeting proposal', meta: 'General', subject: 'Time to connect',
    html: "<p>Hi [first name],</p><p>I'd be glad to find time. Would any of these work for you?</p><ul><li>[option 1]</li><li>[option 2]</li></ul><p>Best,</p>"
  },
  {
    name: 'Document request', meta: 'Operations', subject: 'Request: [document]',
    html: '<p>Hi [first name],</p><p>Could you send the countersigned [document] at your convenience? A reply to this email is fine.</p><p>Thank you,</p>'
  }
];

export const CLASS_COLORS: Record<string, [string, string]> = {
  Public: ['#eefbf5', '#047857'],
  Internal: ['#f4f3f7', '#4a4459'],
  Confidential: ['#fffdf5', '#92400e'],
  Restricted: ['#fef2f2', '#b91c1c'],
  'Not classified': ['#f4f3f7', '#6b6577']
};

/** Gmail rejects messages over 25 MB including encoding overhead. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024 * 0.74;
