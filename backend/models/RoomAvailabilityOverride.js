import mongoose from "mongoose";

const roomAvailabilityOverrideSchema = new mongoose.Schema(
  {
    hotelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hotel",
      required: true,
      index: true,
    },
    roomType: {
      type: String,
      required: true,
      trim: true,
    },
    date: {
      type: Date,
      required: true,
    },
    total: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  { timestamps: true }
);

roomAvailabilityOverrideSchema.index(
  { hotelId: 1, roomType: 1, date: 1 },
  { unique: true }
);

export default mongoose.model(
  "RoomAvailabilityOverride",
  roomAvailabilityOverrideSchema
);
