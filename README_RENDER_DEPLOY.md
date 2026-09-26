# 🚀 রেন্ডার (Render.com) এ সেন্ট্রাল সার্ভার ফ্রি ডেপ্লয় করার নিয়ম

এই সার্ভারটি দিয়ে অ্যাপের সমস্ত কর্মীদের মুভমেন্ট রিয়েল-টাইমে কন্ট্রোল করা হয়। একজন এন্ট্রি দিলে বাকি সবার মোবাইলে মুহূর্তেই চলে আসবে এবং গুগল ম্যাপে তাদের লাইভ লোকেশন দেখা যাবে।

---

### ধাপ ১: গিটহাবে আপলোড করুন (GitHub Repository)
১. [github.com](https://github.com) এ লগইন করে একটি নতুন রিপোজিটরি তৈরি করুন (যেমন: `movement-tracker-server`).
২. এই `server` ফোল্ডারের ফাইলগুলো সেখানে পুশ করুন:
   ```bash
   cd server
   git init
   git add .
   git commit -m "Initial commit for render server"
   git branch -M main
   git remote add origin https://github.com/আপনার-ইউজারনেম/movement-tracker-server.git
   git push -u origin main
   ```

---

### ধাপ ২: Render.com এ সার্ভার চালু করুন (১০০% ফ্রি)
১. [dashboard.render.com](https://dashboard.render.com) এ যান (ফ্রি অ্যাকাউন্ট না থাকলে সাইন-আপ করুন)।
২. **New +** বাটনে ক্লিক করে **Web Service** সিলেক্ট করুন।
৩. আপনার তৈরি করা GitHub রিপোজিটরি সিলেক্ট করুন।
৪. নিচের তথ্যগুলো বসিয়ে দিন:
   - **Name**: `movement-tracker-server` (বা আপনার পছন্দমতো নাম)
   - **Environment**: `Node`
   - **Region**: `Singapore` (বাংলাদেশ থেকে সবচেয়ে ফাস্ট গতির জন্য)
   - **Branch**: `main`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Plan Type**: `Free`
৫. **Create Web Service** বাটনে ক্লিক করুন।
৬. ২ মিনিটের মধ্যে সার্ভার লাইভ হয়ে যাবে এবং আপনাকে একটি লাইভ URL দিবে (যেমন: `https://factory-movement-tracker.onrender.com`).

---

### ধাপ ৩: অ্যাপে সার্ভার লিঙ্ক বসানো
- আপনার রেন্ডার সার্ভার তৈরি হয়ে গেলে সেই লিঙ্কটি অ্যাপের **Settings** অথবা `serverUrl` কনফিগে বসিয়ে দিলেই সমস্ত ফোন স্বয়ংক্রিয়ভাবে সিঙ্ক হয়ে যাবে!
- ব্রাউজারে `https://factory-movement-tracker.onrender.com` খুললে স্বয়ংক্রিয় লাইভ ড্যাশবোর্ড ও গুগল ম্যাপ দেখা যাবে।
- যে কেউ `https://factory-movement-tracker.onrender.com/download/apk` থেকে সরাসরি সর্বশেষ APK ডাউনলোড করতে পারবে।
