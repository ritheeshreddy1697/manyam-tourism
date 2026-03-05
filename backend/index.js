import "dotenv/config";
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import admin from "firebase-admin";
import Razorpay from "razorpay";
import crypto from "crypto";

import { connectDB } from "./db.js";
import User from "./models/User.js";
import Hotel from "./models/Hotel.js";
import Booking from "./models/Booking.js";
import { generateReceipt } from "./utils/receipt.js";
import { sendReceiptMail } from "./utils/mailer.js";
import { upload } from "./utils/cloudinary.js";

/* ================= BASIC SETUP ================= */

const app = express();
app.use(cors());
app.use(express.json());
app.use(
  cors({
    origin: "*", // allow Netlify
    credentials: true
  })
);
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_EMAIL = "manyamtourism@gmail.com";

/* ================= FIREBASE ================= */
  
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

admin.initializeApp({
  credential: admin.credential.cert(
    path.join(__dirname, "firebase-service.json")
  )
});

/* ================= DATABASE ================= */

await connectDB();

/* ================= RAZORPAY ================= */

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

/* ================= AUTH ================= */

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.sendStatus(401);

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.sendStatus(401);
  }
};

const escapeRegExp = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildLooseEmailRegex = (email = "") => {
  const normalized = String(email || "").trim().toLowerCase();
  return new RegExp(`^\\s*${escapeRegExp(normalized)}\\s*$`, "i");
};

/* ================= GOOGLE LOGIN ================= */

app.post("/api/auth/google", async (req, res) => {
  try {
    const decoded = await admin.auth().verifyIdToken(req.body.token);
    const email = decoded.email?.trim().toLowerCase();
    const isAdmin = email === ADMIN_EMAIL.toLowerCase();

    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({
        email,
        role: isAdmin ? "admin" : "user"
      });
    } else if (isAdmin && user.role !== "admin") {
      user.role = "admin";
      await user.save();
    }

    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.json({ token, role: user.role });
  } catch {
    res.status(401).json({ msg: "Invalid Google token" });
  }
});

/* ================= ADMIN ================= */

app.post("/api/admin/make-hotel", auth, async (req, res) => {
  if (req.user.role !== "admin") return res.sendStatus(403);

  const email = String(req.body.email || "").trim().toLowerCase();
  if (!email) return res.status(400).json({ msg: "Email is required" });

  const user = await User.findOneAndUpdate(
    { email },
    { $set: { email, role: "hotel" } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  res.json({
    msg: "Hotel role assigned",
    user: {
      email: user.email,
      role: user.role
    }
  });
});

/* ================= HOTEL PROFILE ================= */

app.get("/api/hotel/profile", auth, async (req, res) => {
  if (req.user.role !== "hotel") return res.sendStatus(403);

  const ownerEmail = String(req.user.email || "").trim().toLowerCase();
  const emailRegex = buildLooseEmailRegex(ownerEmail);

  const hotel = await Hotel.findOne({ ownerEmail: { $regex: emailRegex } });
  res.json(
    hotel || { name: "", location: "", description: "", rooms: [] }
  );
});

app.post("/api/hotel/profile", auth, async (req, res) => {
  if (req.user.role !== "hotel") return res.sendStatus(403);

  const ownerEmail = String(req.user.email || "").trim().toLowerCase();
  const emailRegex = buildLooseEmailRegex(ownerEmail);

  const hotel = await Hotel.findOneAndUpdate(
    { ownerEmail: { $regex: emailRegex } },
    { ...req.body, ownerEmail },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  res.json(hotel);
});

app.get("/api/hotel/bookings", auth, async (req, res) => {
  try {
    if (req.user.role !== "hotel") return res.sendStatus(403);
    res.set("Cache-Control", "no-store");

    const ownerEmail = String(req.user.email || "").trim().toLowerCase();
    const emailRegex = buildLooseEmailRegex(ownerEmail);

    const ownedHotels = await Hotel.find({
      ownerEmail: { $regex: emailRegex }
    }).select("_id");

    if (ownedHotels.length === 0) return res.json([]);

    const hotelIds = ownedHotels.map((hotel) => hotel._id);
    const bookings = await Booking.find({ hotelId: { $in: hotelIds } }).sort({
      checkIn: -1
    });

    res.json(bookings);
  } catch (err) {
    console.error("HOTEL BOOKINGS ERROR:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

/* ================= IMAGE UPLOAD ================= */

app.post(
  "/api/hotel/upload-image",
  auth,
  upload.single("image"),
  async (req, res) => {
    if (req.user.role !== "hotel") return res.sendStatus(403);
    res.json({ url: req.file.path });
  }
);

/* ================= PUBLIC ================= */

app.get("/api/hotels", async (_, res) => {
  res.json(await Hotel.find());
});

/* ================= BOOKINGS ================= */



app.post("/api/bookings", auth, async (req, res) => {
  try {
    if (req.user.role !== "user") return res.sendStatus(403);

    const { hotelId, roomType, checkIn, checkOut } = req.body;

    const hotel = await Hotel.findById(hotelId);
    if (!hotel) return res.status(404).json({ msg: "Hotel not found" });

    const room = hotel.rooms.find(r => r.type === roomType);
    if (!room) return res.status(400).json({ msg: "Invalid room type" });

    console.log("ROOM PRICE RAW:", room.price, typeof room.price);

    const amount = Number(room.price);
    if (!amount || isNaN(amount)) {
      return res.status(400).json({ msg: "Invalid room price" });
    }

    const booking = await Booking.create({
      userEmail: req.user.email,
      hotelId,
      roomType,
      checkIn,
      checkOut,
      amount,               // 🔥 GUARANTEED
      status: "pending"
    });

    console.log("BOOKING AMOUNT SAVED:", booking.amount);

    res.json(booking);
  } catch (err) {
    console.error("BOOKING ERROR:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

app.get("/api/bookings", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin") return res.sendStatus(403);
    res.set("Cache-Control", "no-store");

    const bookings = await Booking.find()
      .populate("hotelId")
      .sort({ checkIn: -1 });

    res.json(bookings);
  } catch (err) {
    console.error("ADMIN BOOKINGS ERROR:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

app.put("/api/bookings/admin/confirm/:id", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin") return res.sendStatus(403);

    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ msg: "Booking not found" });
    }

    const status = String(booking.status || "").toLowerCase();
    if (status === "confirmed") {
      return res.json(booking);
    }

    if (status !== "paid") {
      return res.status(400).json({ msg: "Only paid bookings can be confirmed" });
    }

    booking.status = "confirmed";
    await booking.save();

    res.json(booking);
  } catch (err) {
    console.error("CONFIRM BOOKING ERROR:", err);
    res.status(500).json({ msg: "Server error" });
  }
});


/* ================= FETCH BOOKINGS ================= */


app.get("/api/booking/:id", auth, async (req, res) => {
  try {
    console.log("FETCH BOOKING:", req.params.id);
    console.log("JWT USER:", req.user.email);

    const booking = await Booking.findById(req.params.id)
      .populate("hotelId");

    if (!booking) {
      return res.status(404).json({ msg: "Booking not found" });
    }

    // ✅ normalize emails before comparison
    if (
      req.user.role === "user" &&
      booking.userEmail.trim().toLowerCase() !==
        req.user.email.trim().toLowerCase()
    ) {
      return res.sendStatus(403);
    }

    res.json(booking);
  } catch (err) {
    console.error("BOOKING FETCH ERROR:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

/* ================= PAYMENT ================= */
app.post("/api/payment/order", auth, async (req, res) => {
  try {
    const { bookingId } = req.body;

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ msg: "Booking not found" });
    }

    if (booking.status !== "pending") {
      return res.status(400).json({ msg: "Invalid booking state" });
    }

    const order = await razorpay.orders.create({
      amount: booking.amount * 100, // paise
      currency: "INR",
      receipt: bookingId
    });

    res.json(order);
  } catch (err) {
    console.error("ORDER ERROR:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

app.post("/api/payment/verify", auth, async (req, res) => {
  try {
    console.log("🔔 PAYMENT VERIFY BODY:", req.body);

    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      bookingId
    } = req.body;

    // 1️⃣ Basic validation
    if (
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature ||
      !bookingId
    ) {
      return res.status(400).json({ msg: "Missing payment details" });
    }

    // 2️⃣ Fetch booking
    const booking = await Booking.findById(bookingId).populate("hotelId");
    if (!booking) {
      return res.status(404).json({ msg: "Booking not found" });
    }

    // 3️⃣ Prevent double verification
    if (booking.status === "paid") {
      console.log("⚠️ Booking already paid:", bookingId);
      return res.json({ msg: "Already verified", bookingId: booking._id });
    }

    // 4️⃣ Verify Razorpay signature
    const body = `${razorpay_order_id}|${razorpay_payment_id}`;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      console.error("❌ SIGNATURE MISMATCH");
      return res.status(400).json({ msg: "Payment verification failed" });
    }

    // 5️⃣ Update booking (CRITICAL STEP)
    booking.status = "paid";
    booking.paymentId = razorpay_payment_id;
    await booking.save();

    console.log("✅ BOOKING PAID:", booking._id);

    // 6️⃣ Respond immediately so UI does not wait on email/receipt work
    res.json({
      msg: "Payment verified successfully",
      bookingId: booking._id
    });

    // 7️⃣ Continue receipt/mail in background (non-blocking for user flow)
    setImmediate(async () => {
      try {
        const pdfBuffer = await generateReceipt(booking, booking.hotelId);
        await sendReceiptMail(booking.userEmail, pdfBuffer);
        console.log("📧 Receipt mailed to:", booking.userEmail);
      } catch (mailErr) {
        console.error("❌ MAIL FAILED (ignored):", mailErr.message);
      }
    });

  } catch (err) {
    console.error("🔥 PAYMENT VERIFY ERROR:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

/* ================= SERVER ================= */
app.get("/api/my-bookings", auth, async (req, res) => {
  try {
    console.log("MY BOOKINGS USER:", req.user.email);

    const bookings = await Booking.find({
      userEmail: req.user.email.trim().toLowerCase()
    }).populate("hotelId");

    res.json(bookings);
  } catch (err) {
    console.error("MY BOOKINGS ERROR:", err);
    res.status(500).json({ msg: "Server error" });
  }
});
app.get("/api/booking/:id/receipt", auth, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id)
      .populate("hotelId");

    if (!booking) {
      return res.status(404).json({ msg: "Booking not found" });
    }

    // ✅ FIX: normalize email comparison
    if (
      req.user.role === "user" &&
      booking.userEmail.trim().toLowerCase() !==
        req.user.email.trim().toLowerCase()
    ) {
      return res.sendStatus(403);
    }

    const pdfBuffer = await generateReceipt(booking, booking.hotelId);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=receipt-${booking._id}.pdf`
    );

    res.send(pdfBuffer);
  } catch (err) {
    console.error("RECEIPT ERROR:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

app.listen(5000, () => {
  console.log("🚀 Backend running locally at http://localhost:5000 — deployed at https://manyam-tourism-backend-1.onrender.com");
});
