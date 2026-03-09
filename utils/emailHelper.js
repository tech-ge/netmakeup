const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM   = process.env.EMAIL_FROM || 'TechGeo Network <noreply@techgeo.co.ke>';

// ── Silent sender — email never blocks a response ────────────────────────────
async function sendEmail(to, subject, html) {
  try {
    const { error } = await resend.emails.send({ from: FROM, to, subject, html });
    if (error) console.error('📧 Email error:', error.message);
    return !error;
  } catch (e) {
    console.error('📧 Email failed:', e.message);
    return false;
  }
}

// ── Shared wrapper ────────────────────────────────────────────────────────────
function wrap(content) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#f3f4f6;font-family:'Segoe UI',Arial,sans-serif}
  .wrap{max-width:500px;margin:2rem auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  .hdr{background:linear-gradient(135deg,#16a34a,#15803d);padding:1.5rem 2rem;text-align:center}
  .hdr h1{color:#fff;margin:0;font-size:1.3rem;font-weight:800}
  .hdr p{color:rgba(255,255,255,.75);margin:.25rem 0 0;font-size:.82rem}
  .body{padding:1.75rem 2rem}
  .body p{color:#374151;line-height:1.7;margin:.6rem 0;font-size:.93rem}
  .row{display:flex;justify-content:space-between;padding:.6rem .85rem;font-size:.9rem}
  .row:nth-child(odd){background:#f9fafb}
  .lbl{color:#6b7280}.val{font-weight:700;color:#111827}
  .ftr{background:#f9fafb;padding:1rem 2rem;text-align:center;font-size:.75rem;color:#9ca3af;border-top:1px solid #f3f4f6}
  .btn{display:block;background:#16a34a;color:#fff;text-align:center;padding:.85rem;border-radius:.5rem;text-decoration:none;font-weight:700;margin:1.25rem 0;font-size:.95rem}
</style></head><body>
<div class="wrap">
  <div class="hdr">
    <h1>TechGeo Network</h1>
    <p>techgeo.co.ke</p>
  </div>
  <div class="body">${content}</div>
  <div class="ftr">© TechGeo Network · This is an automated email, do not reply.</div>
</div>
</body></html>`;
}

// ════════════════════════════════════════════════════════════════
// 1. OTP — register, change password, change contact info
// ════════════════════════════════════════════════════════════════
async function sendOTP(email, username, otp, reason = 'verification') {
  const reasons = {
    register:        { title: 'Verify Your Email', desc: 'You are registering a new TechGeo account.' },
    change_password: { title: 'Password Change OTP', desc: 'You requested to change your account password.' },
    change_contact:  { title: 'Contact Update OTP', desc: 'You requested to update your contact information.' },
    forgot_password: { title: 'Reset Your Password', desc: 'You requested a password reset.' },
  };
  const r = reasons[reason] || reasons.register;

  return sendEmail(email, `${r.title} — Your OTP Code`, wrap(`
    <p>Hi <strong>${username}</strong>,</p>
    <p>${r.desc} Use the code below to continue:</p>
    <div style="margin:1.5rem 0;text-align:center">
      <div style="display:inline-block;background:#f0fdf4;border:2.5px dashed #16a34a;
                  border-radius:10px;padding:1.1rem 2.5rem">
        <p style="margin:0;font-size:2.6rem;font-weight:900;letter-spacing:.35em;
                   color:#15803d;font-family:'Courier New',monospace">${otp}</p>
      </div>
    </div>
    <p style="text-align:center;color:#dc2626;font-weight:700;font-size:.85rem">
      ⏱ Expires in 10 minutes
    </p>
    <p style="font-size:.82rem;color:#9ca3af;text-align:center">
      If you did not request this, ignore this email. Your account is safe.
    </p>
  `));
}

// ════════════════════════════════════════════════════════════════
// 2. DEPOSIT CONFIRMED
// ════════════════════════════════════════════════════════════════
async function sendDepositConfirmed(email, username, amount, reference) {
  return sendEmail(email, `✅ Deposit Confirmed — KES ${amount}`, wrap(`
    <p>Hi <strong>${username}</strong>,</p>
    <p>Your deposit has been received and your wallet has been credited.</p>
    <div style="margin:1.25rem 0;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb">
      <div class="row"><span class="lbl">Amount</span><span class="val" style="color:#16a34a">KES ${amount}</span></div>
      <div class="row"><span class="lbl">Reference</span><span class="val" style="font-family:monospace;font-size:.85rem">${reference}</span></div>
      <div class="row"><span class="lbl">Status</span><span class="val" style="color:#16a34a">✅ Credited to wallet</span></div>
      <div class="row"><span class="lbl">Date</span><span class="val">${new Date().toLocaleString('en-KE',{timeZone:'Africa/Nairobi'})}</span></div>
    </div>
    <a href="https://techgeo.co.ke/dashboard.html" class="btn">View My Wallet →</a>
    <p style="font-size:.8rem;color:#9ca3af;text-align:center">
      Keep this reference number for your records: <strong>${reference}</strong>
    </p>
  `));
}

// ════════════════════════════════════════════════════════════════
// 3. WITHDRAWAL SUBMITTED (pending)
// ════════════════════════════════════════════════════════════════
async function sendWithdrawalSubmitted(email, username, amount, type, reference) {
  const label = type === 'points' ? `Points → KES ${amount}` : `KES ${amount}`;
  return sendEmail(email, `⏳ Withdrawal Requested — ${label}`, wrap(`
    <p>Hi <strong>${username}</strong>,</p>
    <p>Your withdrawal request has been received and is now pending admin approval.</p>
    <div style="margin:1.25rem 0;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb">
      <div class="row"><span class="lbl">Amount</span><span class="val">KES ${amount}</span></div>
      <div class="row"><span class="lbl">Type</span><span class="val">${type === 'points' ? 'Points Redemption' : 'KES Wallet'}</span></div>
      <div class="row"><span class="lbl">Reference</span><span class="val" style="font-family:monospace;font-size:.85rem">${reference}</span></div>
      <div class="row"><span class="lbl">Status</span><span class="val" style="color:#d97706">⏳ Pending Approval</span></div>
    </div>
    <div style="background:#fefce8;border:1px solid #fde68a;border-radius:8px;padding:.9rem 1rem;margin:1rem 0">
      <p style="margin:0;font-size:.85rem;color:#92400e">
        📅 <strong>Processing schedule:</strong> Points withdrawals → Tuesdays · KES withdrawals → Thursdays.<br>
        You will receive another email once payment is sent.
      </p>
    </div>
    <a href="https://techgeo.co.ke/dashboard.html" class="btn">Track My Withdrawal →</a>
  `));
}

// ════════════════════════════════════════════════════════════════
// 4. WITHDRAWAL PAID (approved by admin)
// ════════════════════════════════════════════════════════════════
async function sendWithdrawalPaid(email, username, amount, type, transactionCode, paymentMethod) {
  return sendEmail(email, `💸 Withdrawal Paid — KES ${amount}`, wrap(`
    <p>Hi <strong>${username}</strong>,</p>
    <p>Your withdrawal has been approved and the money has been sent to your <strong>${paymentMethod === 'mpesa' ? 'M-Pesa' : 'bank account'}</strong>.</p>
    <div style="margin:1.25rem 0;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb">
      <div class="row"><span class="lbl">Amount Sent</span><span class="val" style="color:#16a34a;font-size:1.1rem">KES ${amount}</span></div>
      <div class="row"><span class="lbl">Paid To</span><span class="val">${paymentMethod === 'mpesa' ? 'M-Pesa' : 'Bank Account'}</span></div>
      <div class="row"><span class="lbl">Transaction Code</span><span class="val" style="font-family:monospace;color:#16a34a">${transactionCode}</span></div>
      <div class="row"><span class="lbl">Type</span><span class="val">${type === 'points' ? 'Points Redemption' : 'KES Wallet'}</span></div>
      <div class="row"><span class="lbl">Date</span><span class="val">${new Date().toLocaleString('en-KE',{timeZone:'Africa/Nairobi'})}</span></div>
      <div class="row"><span class="lbl">Status</span><span class="val" style="color:#16a34a">✅ Paid</span></div>
    </div>
    <p style="font-size:.82rem;color:#6b7280;text-align:center">
      Save your transaction code: <strong style="font-family:monospace">${transactionCode}</strong>
    </p>
    <a href="https://techgeo.co.ke/dashboard.html" class="btn">View Dashboard →</a>
  `));
}

// ════════════════════════════════════════════════════════════════
// 5. WITHDRAWAL REJECTED
// ════════════════════════════════════════════════════════════════
async function sendWithdrawalRejected(email, username, amount, type, reason) {
  return sendEmail(email, `❌ Withdrawal Rejected — KES ${amount}`, wrap(`
    <p>Hi <strong>${username}</strong>,</p>
    <p>Unfortunately your withdrawal request of <strong>KES ${amount}</strong> was not approved.</p>
    <div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:.9rem 1rem;margin:1.25rem 0">
      <p style="margin:0;color:#991b1b;font-size:.9rem">
        <strong>Reason:</strong> ${reason || 'Did not meet withdrawal requirements.'}
      </p>
    </div>
    <div style="margin:1.25rem 0;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb">
      <div class="row"><span class="lbl">Amount</span><span class="val">KES ${amount}</span></div>
      <div class="row"><span class="lbl">Type</span><span class="val">${type === 'points' ? 'Points Redemption' : 'KES Wallet'}</span></div>
      <div class="row"><span class="lbl">Status</span><span class="val" style="color:#dc2626">❌ Rejected</span></div>
    </div>
    <p style="font-size:.88rem;color:#374151">
      Your ${type === 'points' ? 'points remain' : 'balance remains'} unchanged — nothing was deducted.
      If you believe this is an error, contact support.
    </p>
    <a href="https://techgeo.co.ke/dashboard.html" class="btn">Go to Dashboard →</a>
  `));
}

module.exports = {
  sendOTP,
  sendDepositConfirmed,
  sendWithdrawalSubmitted,
  sendWithdrawalPaid,
  sendWithdrawalRejected,
};
