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
import RoomAvailabilityOverride from "./models/RoomAvailabilityOverride.js";
import AttractionMedia from "./models/AttractionMedia.js";
import { generateReceipt } from "./utils/receipt.js";
import { sendReceiptMail } from "./utils/mailer.js";
import {
  attractionUpload,
  cloudinary,
  hotelUpload
} from "./utils/cloudinary.js";

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
const ADMIN_EMAIL = "sankar.yegireddi@gmail.com";
const ATTRACTION_CATEGORIES = ["temples", "waterfalls", "viewpoints", "festivals", "gallery"];

/* ================= FIREBASE ================= */
  
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const getFirebaseServiceAccount = () => {
  const base64Json = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (base64Json) {
    try {
      const decoded = Buffer.from(base64Json, "base64").toString("utf8");
      return JSON.parse(decoded);
    } catch (err) {
      console.error("❌ Invalid FIREBASE_SERVICE_ACCOUNT_BASE64:", err.message);
      process.exit(1);
    }
  }

  const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (inlineJson) {
    try {
      return JSON.parse(inlineJson);
    } catch (err) {
      console.error("❌ Invalid FIREBASE_SERVICE_ACCOUNT_JSON:", err.message);
      process.exit(1);
    }
  }

  const fileFromEnv = process.env.FIREBASE_SERVICE_ACCOUNT_FILE;
  const defaultFile = path.join(__dirname, "firebase-service.json");
  const filePath = fileFromEnv ? path.resolve(fileFromEnv) : defaultFile;

  if (!fs.existsSync(filePath)) {
    console.error(
      "❌ Firebase service account not found. Set FIREBASE_SERVICE_ACCOUNT_JSON in env for deployment."
    );
    process.exit(1);
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error("❌ Failed to read Firebase service account file:", err.message);
    process.exit(1);
  }
};

admin.initializeApp({
  credential: admin.credential.cert(getFirebaseServiceAccount())
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

const adminOnly = (req, res, next) => {
  if (req.user.role !== "admin") return res.sendStatus(403);
  next();
};

const escapeRegExp = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildLooseEmailRegex = (email = "") => {
  const normalized = String(email || "").trim().toLowerCase();
  return new RegExp(`^\\s*${escapeRegExp(normalized)}\\s*$`, "i");
};

const ACTIVE_BOOKING_STATUSES = ["pending", "paid", "confirmed"];

const getAvailabilityLevel = (available, total) => {
  if (available <= 0) return "full";
  if (total <= 0) return "full";

  const ratio = available / total;
  return ratio <= 0.3 ? "fast" : "available";
};

const getMonthParts = (monthValue = "") => {
  const [yearText, monthText] = String(monthValue || "").split("-");
  const year = Number(yearText);
  const month = Number(monthText);

  if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
  if (month < 1 || month > 12) return null;

  return { year, month };
};

const toDateOnly = (date) => date.toISOString().split("T")[0];

const toUtcDateStart = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
};

const normalizeAttractionCategory = (value = "") =>
  String(value || "").trim().toLowerCase();

const clampAttractionFocus = (value, fallback = 50) => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return fallback;
  return Math.min(100, Math.max(0, Math.round(numericValue)));
};

const mapUploadedPhoto = (file) => ({
  url: file.path,
  publicId: file.filename,
  originalName: file.originalname,
  width: Number(file.width) || undefined,
  height: Number(file.height) || undefined,
  focusX: 50,
  focusY: 50
});

const destroyCloudinaryPhoto = async (publicId) => {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
  } catch (err) {
    console.error("CLOUDINARY DELETE ERROR:", err.message);
  }
};

const cleanupUploadedPhotos = async (files = []) => {
  await Promise.all(
    (files || []).map((file) => destroyCloudinaryPhoto(file?.filename))
  );
};

const getDateKeysInRange = (startDate, endDate) => {
  const keys = [];
  for (
    const cursor = new Date(startDate);
    cursor < endDate;
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    keys.push(toDateOnly(cursor));
  }
  return keys;
};

const buildBookedCountByDate = (bookings = [], startDate, endDate) => {
  const bookedByDate = {};

  bookings.forEach((booking) => {
    const bookingStart = toUtcDateStart(booking.checkIn);
    const bookingEnd = toUtcDateStart(booking.checkOut);
    if (!bookingStart || !bookingEnd || bookingEnd <= bookingStart) return;

    const overlapStart =
      bookingStart > startDate ? new Date(bookingStart) : new Date(startDate);
    const overlapEnd = bookingEnd < endDate ? new Date(bookingEnd) : new Date(endDate);
    if (overlapEnd <= overlapStart) return;

    for (
      const cursor = new Date(overlapStart);
      cursor < overlapEnd;
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      const dateKey = toDateOnly(cursor);
      bookedByDate[dateKey] = (bookedByDate[dateKey] || 0) + 1;
    }
  });

  return bookedByDate;
};

const buildOverrideMapByRoomType = (overrides = []) => {
  const map = {};

  overrides.forEach((override) => {
    const roomType = String(override.roomType || "").trim();
    const dateKey = toDateOnly(override.date);
    if (!roomType || !dateKey) return;

    if (!map[roomType]) map[roomType] = {};
    map[roomType][dateKey] = Math.max(0, Number(override.total) || 0);
  });

  return map;
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
    } else if (!isAdmin && user.role === "admin") {
      user.role = "user";
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

app.post("/api/hotel/availability-date", auth, async (req, res) => {
  try {
    if (req.user.role !== "hotel") return res.sendStatus(403);

    const roomType = String(req.body.roomType || "").trim();
    const dateText = String(req.body.date || "").trim();
    const requestedAvailable = Number(req.body.available);

    if (!roomType) {
      return res.status(400).json({ msg: "Room type is required" });
    }
    if (!Number.isFinite(requestedAvailable) || requestedAvailable < 0) {
      return res.status(400).json({ msg: "Available rooms must be 0 or more" });
    }

    const dayStart = toUtcDateStart(dateText);
    if (!dayStart) {
      return res.status(400).json({ msg: "Invalid date. Use YYYY-MM-DD" });
    }
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const ownerEmail = String(req.user.email || "").trim().toLowerCase();
    const emailRegex = buildLooseEmailRegex(ownerEmail);

    const hotel = await Hotel.findOne({ ownerEmail: { $regex: emailRegex } });
    if (!hotel) {
      return res.status(404).json({ msg: "Hotel profile not found" });
    }

    const room = (hotel.rooms || []).find((item) => item.type === roomType);
    if (!room) {
      return res.status(400).json({ msg: "Invalid room type" });
    }

    const booked = await Booking.countDocuments({
      hotelId: hotel._id,
      roomType,
      status: { $in: ACTIVE_BOOKING_STATUSES },
      checkIn: { $lt: dayEnd },
      checkOut: { $gt: dayStart },
    });

    const available = Math.max(0, Math.floor(requestedAvailable));
    const total = booked + available;
    const baseTotal = Math.max(0, Number(room.total) || 0);

    if (total === baseTotal) {
      await RoomAvailabilityOverride.findOneAndDelete({
        hotelId: hotel._id,
        roomType,
        date: dayStart,
      });
    } else {
      await RoomAvailabilityOverride.findOneAndUpdate(
        {
          hotelId: hotel._id,
          roomType,
          date: dayStart,
        },
        {
          $set: { total },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    res.json({
      hotelId: hotel._id,
      roomType,
      date: toDateOnly(dayStart),
      booked,
      available,
      total,
      level: getAvailabilityLevel(available, total),
    });
  } catch (err) {
    console.error("HOTEL DATE AVAILABILITY UPDATE ERROR:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

/* ================= IMAGE UPLOAD ================= */

app.post(
  "/api/hotel/upload-image",
  auth,
  hotelUpload.single("image"),
  async (req, res) => {
    if (req.user.role !== "hotel") return res.sendStatus(403);
    res.json({ url: req.file.path });
  }
);

app.get("/api/attractions/media", async (req, res) => {
  try {
    const category = normalizeAttractionCategory(req.query.category);
    const slug = String(req.query.slug || "").trim();

    if (category && !ATTRACTION_CATEGORIES.includes(category)) {
      return res.status(400).json({ msg: "Invalid attraction category" });
    }

    if (slug && !category) {
      return res.status(400).json({ msg: "Category is required with slug" });
    }

    const query = {};
    if (category) query.category = category;
    if (slug) query.slug = slug;

    if (slug) {
      const media = await AttractionMedia.findOne(query).lean();
      return res.json(media || { category, slug, photos: [] });
    }

    const media = await AttractionMedia.find(query).sort({ updatedAt: -1 }).lean();
    res.json(media);
  } catch (err) {
    console.error("ATTRACTION MEDIA FETCH ERROR:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

app.post(
  "/api/admin/attractions/media",
  auth,
  adminOnly,
  attractionUpload.array("photos"),
  async (req, res) => {
    try {
      const category = normalizeAttractionCategory(req.body.category);
      const slug = String(req.body.slug || "").trim();
      const files = Array.isArray(req.files) ? req.files : [];

      if (!ATTRACTION_CATEGORIES.includes(category)) {
        await cleanupUploadedPhotos(files);
        return res.status(400).json({ msg: "Invalid attraction category" });
      }

      if (!slug) {
        await cleanupUploadedPhotos(files);
        return res.status(400).json({ msg: "Attraction slug is required" });
      }

      if (files.length === 0) {
        return res.status(400).json({ msg: "Select at least one photo" });
      }

      const existingMedia = await AttractionMedia.findOne({ category, slug });

      const newPhotos = files.map(mapUploadedPhoto);
      const updatedMedia = await AttractionMedia.findOneAndUpdate(
        { category, slug },
        {
          $setOnInsert: { category, slug },
          $push: { photos: { $each: newPhotos } }
        },
        {
          new: true,
          upsert: true,
          setDefaultsOnInsert: true
        }
      );

      res.json(updatedMedia);
    } catch (err) {
      await cleanupUploadedPhotos(req.files);
      console.error("ATTRACTION MEDIA UPLOAD ERROR:", err);
      res.status(500).json({ msg: "Server error" });
    }
  }
);

app.delete("/api/admin/attractions/media", auth, adminOnly, async (req, res) => {
  try {
    const category = normalizeAttractionCategory(req.body.category);
    const slug = String(req.body.slug || "").trim();
    const publicId = String(req.body.publicId || "").trim();

    if (!ATTRACTION_CATEGORIES.includes(category)) {
      return res.status(400).json({ msg: "Invalid attraction category" });
    }

    if (!slug || !publicId) {
      return res
        .status(400)
        .json({ msg: "Attraction slug and photo id are required" });
    }

    const media = await AttractionMedia.findOne({ category, slug });
    if (!media) {
      return res.status(404).json({ msg: "Attraction gallery not found" });
    }

    const remainingPhotos = (media.photos || []).filter(
      (photo) => photo.publicId !== publicId
    );

    if (remainingPhotos.length === media.photos.length) {
      return res.status(404).json({ msg: "Photo not found" });
    }

    await destroyCloudinaryPhoto(publicId);

    if (remainingPhotos.length === 0) {
      await AttractionMedia.deleteOne({ _id: media._id });
      return res.json({ category, slug, photos: [] });
    }

    media.photos = remainingPhotos;
    await media.save();

    res.json(media);
  } catch (err) {
    console.error("ATTRACTION MEDIA DELETE ERROR:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

app.patch("/api/admin/attractions/media", auth, adminOnly, async (req, res) => {
  try {
    const category = normalizeAttractionCategory(req.body.category);
    const slug = String(req.body.slug || "").trim();
    const publicId = String(req.body.publicId || "").trim();

    if (!ATTRACTION_CATEGORIES.includes(category)) {
      return res.status(400).json({ msg: "Invalid attraction category" });
    }

    if (!slug || !publicId) {
      return res
        .status(400)
        .json({ msg: "Attraction slug and photo id are required" });
    }

    const media = await AttractionMedia.findOne({ category, slug });
    if (!media) {
      return res.status(404).json({ msg: "Attraction gallery not found" });
    }

    const photo = (media.photos || []).find((item) => item.publicId === publicId);
    if (!photo) {
      return res.status(404).json({ msg: "Photo not found" });
    }

    photo.focusX = clampAttractionFocus(req.body.focusX, photo.focusX);
    photo.focusY = clampAttractionFocus(req.body.focusY, photo.focusY);

    await media.save();

    res.json(media);
  } catch (err) {
    console.error("ATTRACTION MEDIA UPDATE ERROR:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

/* ================= PUBLIC ================= */

app.get("/", (_, res) => {
  res.json({ status: "ok", message: "Manyam Tourism backend is live" });
});

app.get("/api/hotels", async (_, res) => {
  res.json(await Hotel.find());
});

app.get("/api/hotels/:id/availability", async (req, res) => {
  try {
    const { id } = req.params;
    const { checkIn, checkOut } = req.query;

    const hotel = await Hotel.findById(id);
    if (!hotel) {
      return res.status(404).json({ msg: "Hotel not found" });
    }

    const checkInDate = toUtcDateStart(checkIn);
    const checkOutDate = toUtcDateStart(checkOut);
    const hasValidDates =
      !!checkInDate &&
      !!checkOutDate &&
      checkOutDate > checkInDate;

    const bookingQuery = hasValidDates
      ? {
          hotelId: hotel._id,
          status: { $in: ACTIVE_BOOKING_STATUSES },
          checkIn: { $lt: checkOutDate },
          checkOut: { $gt: checkInDate },
        }
      : null;

    const overlappingBookings = bookingQuery
      ? await Booking.find(bookingQuery).select("roomType checkIn checkOut")
      : [];

    const overrides = hasValidDates
      ? await RoomAvailabilityOverride.find({
          hotelId: hotel._id,
          date: { $gte: checkInDate, $lt: checkOutDate },
        }).select("roomType date total")
      : [];

    const bookingsByType = {};
    overlappingBookings.forEach((booking) => {
      const type = String(booking.roomType || "").trim();
      if (!type) return;
      if (!bookingsByType[type]) bookingsByType[type] = [];
      bookingsByType[type].push(booking);
    });

    const overridesByRoomType = buildOverrideMapByRoomType(overrides);
    const selectedDateKeys = hasValidDates
      ? getDateKeysInRange(checkInDate, checkOutDate)
      : [];

    const rooms = (hotel.rooms || []).map((room) => {
      const total = Math.max(0, Number(room.total) || 0);
      const type = String(room.type || "").trim();

      if (!hasValidDates) {
        return {
          type: room.type,
          price: Number(room.price) || 0,
          total,
          booked: 0,
          available: total,
          level: getAvailabilityLevel(total, total),
        };
      }

      const bookedByDate = buildBookedCountByDate(
        bookingsByType[type] || [],
        checkInDate,
        checkOutDate
      );
      const overrideByDate = overridesByRoomType[type] || {};

      let minAvailable = Number.POSITIVE_INFINITY;
      let maxBooked = 0;

      selectedDateKeys.forEach((dateKey) => {
        const totalForDay =
          overrideByDate[dateKey] !== undefined ? overrideByDate[dateKey] : total;
        const bookedForDay = bookedByDate[dateKey] || 0;
        const availableForDay = Math.max(totalForDay - bookedForDay, 0);

        if (availableForDay < minAvailable) minAvailable = availableForDay;
        if (bookedForDay > maxBooked) maxBooked = bookedForDay;
      });

      if (!Number.isFinite(minAvailable)) minAvailable = total;

      return {
        type: room.type,
        price: Number(room.price) || 0,
        total,
        booked: maxBooked,
        available: minAvailable,
        level: getAvailabilityLevel(minAvailable, total),
      };
    });

    const totalRooms = rooms.reduce((sum, room) => sum + room.total, 0);

    res.json({
      hotelId: hotel._id,
      checkIn: hasValidDates ? checkInDate : null,
      checkOut: hasValidDates ? checkOutDate : null,
      totalRooms,
      rooms,
    });
  } catch (err) {
    console.error("HOTEL AVAILABILITY ERROR:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

app.get("/api/hotels/:id/availability-calendar", async (req, res) => {
  try {
    const { id } = req.params;
    const hotel = await Hotel.findById(id);
    if (!hotel) return res.status(404).json({ msg: "Hotel not found" });

    const fallbackRoomType = hotel.rooms?.[0]?.type || "";
    const roomType = String(req.query.roomType || fallbackRoomType).trim();
    if (!roomType) {
      return res.status(400).json({ msg: "Room type is required" });
    }

    const room = (hotel.rooms || []).find((item) => item.type === roomType);
    if (!room) {
      return res.status(400).json({ msg: "Invalid room type" });
    }

    const now = new Date();
    const defaultMonth = `${now.getUTCFullYear()}-${String(
      now.getUTCMonth() + 1
    ).padStart(2, "0")}`;
    const monthParts = getMonthParts(req.query.month || defaultMonth);
    if (!monthParts) {
      return res.status(400).json({ msg: "Invalid month. Use YYYY-MM format" });
    }

    const { year, month } = monthParts;
    const monthStart = new Date(Date.UTC(year, month - 1, 1));
    const monthEnd = new Date(Date.UTC(year, month, 1));

    const bookings = await Booking.find({
      hotelId: hotel._id,
      roomType,
      status: { $in: ACTIVE_BOOKING_STATUSES },
      checkIn: { $lt: monthEnd },
      checkOut: { $gt: monthStart },
    }).select("checkIn checkOut");

    const overrides = await RoomAvailabilityOverride.find({
      hotelId: hotel._id,
      roomType,
      date: { $gte: monthStart, $lt: monthEnd },
    }).select("date total");

    const overrideByDate = {};
    overrides.forEach((override) => {
      overrideByDate[toDateOnly(override.date)] = Math.max(
        0,
        Number(override.total) || 0
      );
    });

    const baseTotalRooms = Number(room.total) || 0;
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

    const days = [];
    for (let day = 1; day <= daysInMonth; day += 1) {
      const dayStart = new Date(Date.UTC(year, month - 1, day));
      const dayEnd = new Date(Date.UTC(year, month - 1, day + 1));
      const dateKey = toDateOnly(dayStart);
      const totalRooms =
        overrideByDate[dateKey] !== undefined
          ? overrideByDate[dateKey]
          : baseTotalRooms;

      let booked = 0;
      bookings.forEach((booking) => {
        const overlaps = booking.checkIn < dayEnd && booking.checkOut > dayStart;
        if (overlaps) booked += 1;
      });

      const available = Math.max(totalRooms - booked, 0);
      days.push({
        date: dateKey,
        total: totalRooms,
        booked,
        available,
        level: getAvailabilityLevel(available, totalRooms),
      });
    }

    res.json({
      hotelId: hotel._id,
      roomType,
      month: `${year}-${String(month).padStart(2, "0")}`,
      totalRooms: baseTotalRooms,
      days,
    });
  } catch (err) {
    console.error("HOTEL AVAILABILITY CALENDAR ERROR:", err);
    res.status(500).json({ msg: "Server error" });
  }
});

/* ================= BOOKINGS ================= */



app.post("/api/bookings", auth, async (req, res) => {
  try {
    if (req.user.role !== "user") return res.sendStatus(403);

    const { hotelId, roomType, checkIn, checkOut, guestName, phone, adults, children } = req.body;

    const hotel = await Hotel.findById(hotelId);
    if (!hotel) return res.status(404).json({ msg: "Hotel not found" });

    const room = hotel.rooms.find(r => r.type === roomType);
    if (!room) return res.status(400).json({ msg: "Invalid room type" });

    const checkInDate = toUtcDateStart(checkIn);
    const checkOutDate = toUtcDateStart(checkOut);
    if (
      !checkInDate ||
      !checkOutDate ||
      checkOutDate <= checkInDate
    ) {
      return res.status(400).json({ msg: "Invalid booking dates" });
    }

    const normalizedGuestName = String(guestName || "").trim();
    const normalizedPhone = String(phone || "").trim();
    const adultsCount = Number(adults);
    const childrenCount = Number(children ?? 0);

    if (!normalizedGuestName) {
      return res.status(400).json({ msg: "Guest name is required" });
    }
    if (!normalizedPhone) {
      return res.status(400).json({ msg: "Phone number is required" });
    }
    if (!Number.isInteger(adultsCount) || adultsCount < 1 || adultsCount > 2) {
      return res.status(400).json({ msg: "Adults per room must be 1 or 2" });
    }
    if (!Number.isInteger(childrenCount) || childrenCount < 0) {
      return res.status(400).json({ msg: "Children count must be 0 or more" });
    }

    const overlappingBookings = await Booking.find({
      hotelId: hotel._id,
      roomType,
      status: { $in: ACTIVE_BOOKING_STATUSES },
      checkIn: { $lt: checkOutDate },
      checkOut: { $gt: checkInDate },
    }).select("checkIn checkOut");

    const overrides = await RoomAvailabilityOverride.find({
      hotelId: hotel._id,
      roomType,
      date: { $gte: checkInDate, $lt: checkOutDate },
    }).select("date total");

    const overrideByDate = {};
    overrides.forEach((override) => {
      overrideByDate[toDateOnly(override.date)] = Math.max(
        0,
        Number(override.total) || 0
      );
    });

    const bookedByDate = buildBookedCountByDate(
      overlappingBookings,
      checkInDate,
      checkOutDate
    );
    const stayDateKeys = getDateKeysInRange(checkInDate, checkOutDate);
    const baseTotalRooms = Math.max(0, Number(room.total) || 0);

    const isUnavailableForAnyDay = stayDateKeys.some((dateKey) => {
      const totalForDay =
        overrideByDate[dateKey] !== undefined
          ? overrideByDate[dateKey]
          : baseTotalRooms;
      const bookedForDay = bookedByDate[dateKey] || 0;
      return bookedForDay >= totalForDay;
    });

    if (isUnavailableForAnyDay) {
      return res.status(400).json({
        msg: "No vacancies available for selected room type and dates",
      });
    }

    console.log("ROOM PRICE RAW:", room.price, typeof room.price);

    const amountPerNight = Number(room.price);
    if (!amountPerNight || Number.isNaN(amountPerNight)) {
      return res.status(400).json({ msg: "Invalid room price" });
    }

    const nights = Math.round(
      (checkOutDate.getTime() - checkInDate.getTime()) / (24 * 60 * 60 * 1000)
    );
    if (!Number.isInteger(nights) || nights <= 0) {
      return res.status(400).json({ msg: "Invalid number of nights" });
    }

    const amount = amountPerNight * nights;

    const booking = await Booking.create({
      userEmail: req.user.email,
      hotelId,
      roomType,
      guestName: normalizedGuestName,
      phone: normalizedPhone,
      adults: adultsCount,
      children: childrenCount,
      checkIn: checkInDate,
      checkOut: checkOutDate,
      amount,
      status: "pending"
    });

    console.log("BOOKING AMOUNT SAVED:", booking.amount, "NIGHTS:", nights, "RATE:", amountPerNight);

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
    const currentStatus = String(booking.status || "").toLowerCase();
    if (currentStatus === "confirmed") {
      console.log("⚠️ Booking already confirmed:", bookingId);
      return res.json({ msg: "Already verified", bookingId: booking._id });
    }

    // Backward compatibility for old "paid" records: upgrade to confirmed.
    if (currentStatus === "paid") {
      booking.status = "confirmed";
      await booking.save();
      console.log("⚠️ Upgraded paid booking to confirmed:", bookingId);
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
    booking.status = "confirmed";
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

if (process.env.VERCEL !== "1") {
  app.listen(5000, () => {
    console.log(
      "🚀 Backend running locally at http://localhost:5000 — deployed at https://manyam-tourism-backend-1.onrender.com"
    );
  });
}

export default app;
