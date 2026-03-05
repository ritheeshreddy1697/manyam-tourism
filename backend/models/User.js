import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  email: { type: String, unique: true },
  role: { type: String, enum: ["admin", "hotel", "user"] }
});

export default mongoose.model("User", userSchema);
