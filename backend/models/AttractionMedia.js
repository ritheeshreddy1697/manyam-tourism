import mongoose from "mongoose";

const attractionPhotoSchema = new mongoose.Schema(
  {
    url: {
      type: String,
      required: true
    },
    publicId: {
      type: String,
      required: true
    },
    originalName: String,
    width: Number,
    height: Number
  },
  {
    _id: false
  }
);

const attractionMediaSchema = new mongoose.Schema(
  {
    category: {
      type: String,
      required: true,
      enum: ["temples", "waterfalls", "viewpoints", "festivals"]
    },
    slug: {
      type: String,
      required: true
    },
    photos: {
      type: [attractionPhotoSchema],
      default: []
    }
  },
  {
    timestamps: true
  }
);

attractionMediaSchema.index({ category: 1, slug: 1 }, { unique: true });

export default mongoose.model("AttractionMedia", attractionMediaSchema);
