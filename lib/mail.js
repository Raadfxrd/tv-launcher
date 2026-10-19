/**
 * Turns whatever delivered an email into one plain shape:
 *   {from, to, subject, date, text}
 *
 * Accepted: Postmark's inbound webhook JSON (From, Subject, TextBody,
 * HtmlBody, …), or a generic {from, to, subject, date, text, html} object, which
 * is what a future Proton Mail Bridge poller would send.
 */

const MAX_TEXT = 12000; // plenty for a shipping email; keeps the Claude call small

function decodeEntities(s) {
	return s
		.replace(/&nbsp;/gi, ' ')
		.replace(/&amp;/gi, '&')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

/* HTML to readable text, keeping link targets ("Track (https://…)") because
   tracking links often carry the code and the postcode. */
function htmlToText(html = '') {
	return decodeEntities(
		String(html)
			.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
			.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
				const text = label.replace(/<[^>]+>/g, ' ').trim();
				return /^https?:/i.test(href) ? ` ${text} (${href}) ` : ` ${text} `;
			})
			.replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)[^>]*>/gi, '\n')
			.replace(/<[^>]+>/g, ' ')
	)
		.replace(/[ \t\f\v]+/g, ' ')
		.replace(/\n\s*\n+/g, '\n')
		.trim();
}

function normalise(body = {}) {
	if (body.Subject !== undefined || body.TextBody !== undefined || body.HtmlBody !== undefined) {
		const text = body.HtmlBody ? htmlToText(body.HtmlBody) : String(body.TextBody || '');
		return {
			from: body.FromFull?.Email || body.From || '',
			fromName: body.FromFull?.Name || body.FromName || '',
			to: body.OriginalRecipient || body.To || '',
			subject: String(body.Subject || ''),
			date: body.Date || new Date().toISOString(),
			text: text.slice(0, MAX_TEXT),
		};
	}
	const text = body.html ? htmlToText(body.html) : String(body.text || '');
	return {
		from: String(body.from || ''),
		fromName: String(body.fromName || ''),
		to: String(body.to || ''),
		subject: String(body.subject || ''),
		date: body.date || new Date().toISOString(),
		text: text.slice(0, MAX_TEXT),
	};
}

/* Proton asks the receiving address to accept forwarding with a link. That
   email has to reach you, not the parser. */
function forwardingConfirmation(mail) {
	if (!/proton/i.test(mail.from) || !/forward/i.test(`${mail.subject} ${mail.text}`)) return null;
	const links = mail.text.match(/https:\/\/[^\s)"'<>]+/g) || [];
	const link = links.find((l) => /proton\.me|protonmail\.com/i.test(l) && /forward|accept|confirm/i.test(l)) || links.find((l) => /proton/i.test(l));
	return link ? {link} : {link: null};
}

module.exports = {normalise, htmlToText, forwardingConfirmation, MAX_TEXT};
