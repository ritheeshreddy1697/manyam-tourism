import mongoose from "mongoose";

const hotelSchema = new mongoose.Schema({
  name: String,
  location: String,
  description: String,
  ownerEmail: String,
  rooms: [
  {
    type: {
      type: String,
      required: true
    },
    price: {
      type: Number,   // 🔒 MUST BE NUMBER
      required: true
    },
    total: {
      type: Number,
      required: true
    }
  }
],

  images: [String]   // 🔥 CLOUDINARY URLs
});

export default mongoose.model("Hotel", hotelSchema);
