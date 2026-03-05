import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

export const sendReceiptMail = async (to, pdfBuffer) => {
  await transporter.sendMail({
    from: `"Manyam Tourism" <${process.env.EMAIL_USER}>`,
    to,
    subject: "Your Booking Receipt",
    text: "Thank you for booking with Manyam Tourism. Receipt attached.",
    attachments: [
      {
        filename: "receipt.pdf",
        content: pdfBuffer
      }
    ]
  });

  console.log("📧 Mail sent to:", to);
};