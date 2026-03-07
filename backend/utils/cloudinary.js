import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import multer from "multer";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const createStorage = (folder) =>
  new CloudinaryStorage({
    cloudinary,
    params: {
      folder,
      allowed_formats: ["jpg", "png", "jpeg", "webp"]
    }
  });

export const hotelUpload = multer({ storage: createStorage("manyam-hotels") });
export const attractionUpload = multer({
  storage: createStorage("manyam-attractions")
});

export { cloudinary };
