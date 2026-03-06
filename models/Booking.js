import mongoose from "mongoose";

const bookingSchema = new mongoose.Schema({
  userEmail: {
    type: String,
    required: true
  },

  hotelId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Hotel",
    required: true
  },

  roomType: {
    type: String,
    required: true
  },

  guestName: {
    type: String,
    default: ""
  },

  phone: {
    type: String,
    default: ""
  },

  adults: {
    type: Number,
    min: 1,
    max: 2,
    default: 1
  },

  children: {
    type: Number,
    min: 0,
    default: 0
  },

  amount: {
    type: Number,
    required: true
  },

  checkIn: {
    type: Date,
    required: true
  },

  checkOut: {
    type: Date,
    required: true
  },

  status: {
    type: String,
    enum: ["pending", "paid", "confirmed", "cancelled"],
    default: "pending"
  },

  paymentId: String
});

export default mongoose.model("Booking", bookingSchema);
