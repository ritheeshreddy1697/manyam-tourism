import PDFDocument from "pdfkit";

export const generateReceipt = (booking, hotel) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const buffers = [];

      doc.on("data", buffers.push.bind(buffers));
      doc.on("end", () => {
        resolve(Buffer.concat(buffers));
      });

      doc.fontSize(22).text("Manyam Tourism", { align: "center" });
      doc.moveDown();

      doc.fontSize(16).text("Booking Confirmation", { align: "center" });
      doc.moveDown(2);

      doc.fontSize(12);
      doc.text(`Booking ID: ${booking._id}`);
      doc.text(`Hotel Name: ${hotel.name}`);
      doc.text(`Location: ${hotel.location}`);
      doc.text(`Check-in: ${booking.checkIn}`);
      doc.text(`Check-out: ${booking.checkOut}`);
      doc.text(`Payment ID: ${booking.paymentId}`);
      doc.text(`Status: PAID`);

      doc.moveDown(2);
      doc.text("Thank you for booking with Manyam Tourism!");

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
};
