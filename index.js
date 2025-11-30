const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();
const axios = require('axios');
const { Expo } = require('expo-server-sdk');

// Create a new Expo SDK client
const expo = new Expo();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ✅ Decode Firebase Admin key from .env
const firebaseKey = JSON.parse(
  Buffer.from(process.env.EXPO_ANDROID_KEY, 'base64').toString('utf-8')
);

admin.initializeApp({
  credential: admin.credential.cert(firebaseKey),
  storageBucket: 'agriconnectdatabase.appspot.com', // ✅ make sure this is exact
});

const db = admin.firestore();
const bucket = admin.storage().bucket();

app.post("/send-notification", async (req, res) => {
  const { expoPushToken, title, body } = req.body;

  try {
    // Send push notification via Expo
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to: expoPushToken,
        sound: "default",
        title,
        body,
      }),
    });

    const data = await response.json(); // ✅ parse Expo's response
    res.status(200).json({ success: true, expoResponse: data }); // ✅ return valid JSON
  } catch (error) {
    console.error("❌ Notification error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});



app.post('/orders', async (req, res) => {
  try {
    const { sellerId, orderId, orderDetails } = req.body;

    if (!sellerId || !orderId) {
      return res.status(400).json({ message: 'sellerId and orderId are required' });
    }

    // 1️⃣ Save order in Firestore
    await db.collection('orders').doc(orderId).set({
      sellerId,
      orderId,
      orderDetails: orderDetails || {},
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // 2️⃣ Get seller's Expo Push Token
    const sellerDoc = await db.collection('users').doc(sellerId).get();
    if (!sellerDoc.exists) return res.status(404).json({ message: 'Seller not found' });

    const expoPushToken = sellerDoc.data().expoPushToken;
    if (!expoPushToken) return res.status(400).json({ message: 'Seller has no push token' });

    // 3️⃣ Send push notification via Expo
    await axios.post('https://exp.host/--/api/v2/push/send', {
      to: expoPushToken,
      sound: 'default',
      title: 'New Order Received!',
      body: `You have a new order: ${orderId}`,
      data: { orderId },
    });

    res.status(200).json({ message: 'Order created and notification sent!' });
  } catch (error) {
    console.error('❌ Error creating order:', error);
    res.status(500).json({ message: 'Something went wrong', error: error.message });
  }
});

app.post("/createriderlocation", async (req, res) => {
  try {
    const {
      addressId,
      userId,
      name,
      municipality,
      barangay,
      addressDetails,
      isDefault,
      latitude,
      longitude,
      createdAt,
    } = req.body;

    if (!userId || !municipality || !barangay) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Save to Firestore → rider_location collection
    await db
      .collection("rider_location")
      .doc(addressId)
      .set({
        userId,
        name,
        municipality,
        barangay,
        addressDetails,
        isDefault,
        latitude,
        longitude,
        createdAt,
      });

    res.json({ success: true, message: "Rider location saved successfully" });
  } catch (error) {
    console.error("🔥 Error saving rider location:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});



app.post('/createaddress', async (req, res) => {
  try {
    console.log("📦 Received payload:", req.body); // 🟢 Log incoming payload

    const {
      addressId,
      userId,
      name,
      municipality,
      barangay,
      addressDetails,
      isDefault,
      createdAt,
      latitude,
      longitude, // ✅ Added
    } = req.body;

    if (!addressId || !userId || !name || !municipality || !barangay) {
      return res.status(400).json({ error: '❌ Missing required address fields' });
    }

    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: '❌ Missing geocoding coordinates (latitude & longitude)' });
    }

    const newAddress = {
      addressId,
      userId,
      name,
      municipality,
      barangay,
      addressDetails: addressDetails || '',
      isDefault: !!isDefault,
      latitude,   // ✅ Save latitude
      longitude,  // ✅ Save longitude
      createdAt: createdAt || new Date().toISOString(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection('delivery_address').doc(addressId).set(newAddress);

    return res.status(201).json({
      message: '✅ Address created successfully',
      addressId,
      address: newAddress,
    });
  } catch (err) {
    console.error('[CreateAddress Error]', err);
    return res.status(500).json({ error: '❌ Failed to create address', details: err.message });
  }
});



app.post("/createorder", async (req, res) => {
  try {
    console.log("📦 Received order payload:", req.body);

    const {
      orderId,
      userId,
      products,
      total,
      deliveryAddress,
      distance,
      storeId, // storeId is used to find seller
      status,
      orderStatus,
      createdAt,
    } = req.body;

    if (!orderId || !userId || !products || !deliveryAddress) {
      return res.status(400).json({ error: "❌ Missing required order fields" });
    }

    // 🔹 Recalculate subtotal
    let recalculatedTotal = 0;
    let totalWeightKg = 0;

    products.forEach((item) => {
      const itemSubtotal = item.price * item.quantity;
      recalculatedTotal += itemSubtotal;

      if (item.unit === "kg") {
        totalWeightKg += item.quantity;
      } else if (item.unit === "liter(1L)") {
        totalWeightKg += item.quantity * 1;
      } else if (item.unit === "dozen (Egg)") {
        totalWeightKg += item.quantity * 1.2;
      } else if (item.unit === "box(10-15kg)") {
        totalWeightKg += item.quantity * 12.5;
      } else {
        totalWeightKg += item.quantity * 0.5;
      }
    });

    const distanceFee = distance * 2;
    let weightFee = 0;
    if (totalWeightKg <= 5) weightFee = 10;
    else if (totalWeightKg <= 10) weightFee = 20;
    else if (totalWeightKg <= 20) weightFee = 30;
    else weightFee = 50;

    const deliveryFee = distanceFee + weightFee;
    const grandTotal = recalculatedTotal + deliveryFee;

    const newOrder = {
      orderId,
      userId,
      products,
      total: recalculatedTotal,
      deliveryAddress,
      distance,
      totalWeightKg: Number(totalWeightKg.toFixed(2)),
      deliveryFee,
      grandTotal,
      storeId,
      orderStatus: "pending",
      status: status || "pending",
      createdAt: createdAt || new Date().toISOString(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // ✅ Save the order
    await db.collection("Orders").doc(orderId).set(newOrder);
    console.log("✅ Order saved:", orderId);

    // ==============================
    // 🔔 SEND PUSH NOTIFICATION TO SELLER
    // ==============================
    if (storeId) {
      try {
        // 🔹 Step 1: Find the store by storeId
        const storeDoc = await db.collection("stores").doc(storeId).get();

        if (!storeDoc.exists) {
          console.warn("⚠️ Store not found for storeId:", storeId);
        } else {
          const storeData = storeDoc.data();
          const ownerId = storeData.ownerId;

          if (!ownerId) {
            console.warn("⚠️ No ownerId found in store document:", storeId);
          } else {
            // 🔹 Step 2: Get the seller (owner) user document
            const sellerDoc = await db.collection("users").doc(ownerId).get();

            if (sellerDoc.exists && sellerDoc.data().expoPushToken) {
              const sellerToken = sellerDoc.data().expoPushToken;

             if (Expo.isExpoPushToken(sellerToken)) {
                const message = {
                  to: sellerToken,
                  sound: "default",
                  title: "📦 New Order Received!",
                  body: `A buyer just placed a new order for your store "${storeData.storeName}".`,
                  data: { orderId },
                };

                try {
                  // ✅ Fix: Use chunking instead of sending directly
                  const messages = [message];
                  const chunks = expo.chunkPushNotifications(messages);

                  for (const chunk of chunks) {
                    const tickets = await expo.sendPushNotificationsAsync(chunk);
                    console.log("✅ Notification tickets:", tickets);
                  }

                  console.log("✅ Push notification sent to seller:", ownerId);
                } catch (notifError) {
                  console.error("❌ Error sending push notification:", notifError);
                }
              } else {
                console.warn("⚠️ Invalid Expo push token for seller:", ownerId);
              }
                          } else {
              console.warn("⚠️ No push token found for seller:", ownerId);
            }
          }
        }
      } catch (notifErr) {
        console.error("❌ Error during notification logic:", notifErr);
      }
    }

    // ✅ Respond to client
    return res.status(201).json({
      message: "✅ Order created and seller notified successfully",
      orderId,
      order: newOrder,
    });
  } catch (err) {
    console.error("[CreateOrder Error]", err);
    return res
      .status(500)
      .json({ error: "❌ Failed to create order", details: err.message });
  }
});







app.post('/createproduct', async (req, res) => {
  try {
    const {
      productId,
      storeId,
      brandName,
      ownerId,
      ownerName,
      productName,
      categories,
      productDescription,
      productImages,
      unit, 
      variants,
      createdAt,
    } = req.body;

    // 🔍 Basic validation
    if (
      !productId ||
      !storeId ||
      !brandName ||
      !ownerId ||
      !ownerName ||
      !productName ||
      !categories || !categories.length ||
      !productImages || !productImages.length
    ) {
      return res.status(400).json({ error: '❌ Missing required product fields' });
    }

    // ✅ Validate variants if provided
    if (variants && variants.length) {
      for (const v of variants) {
        if (!v.name || !v.stock || !v.price) {
          return res.status(400).json({ error: '❌ Each variant must have name, stock, and price' });
        }
        if (isNaN(v.stock) || Number(v.stock) < 0) {
          return res.status(400).json({ error: `❌ Variant "${v.name}" stock must be a non-negative number` });
        }
        if (isNaN(v.price) || Number(v.price) <= 0) {
          return res.status(400).json({ error: `❌ Variant "${v.name}" price must be a positive number` });
        }
      }
    }

    const newProduct = {
      productId, // ✅ keep client-generated ID
      storeId,
      brandName,
      ownerId,
      ownerName,
      productName,
      categories,
      productDescription: productDescription || '',
      productImages,
       unit: unit || 'kg', 
      variants: variants?.map(v => ({
        name: v.name,
        stock: Number(v.stock),
        price: Number(v.price),
      })) || [],
      createdAt: createdAt || new Date().toISOString(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'active',
    };

    // ✅ Save using productId as document ID
    await db.collection('products').doc(productId).set(newProduct);

    return res.status(201).json({
      message: '✅ Product created successfully',
      productId,
      product: newProduct,
    });
  } catch (err) {
    console.error('[CreateProduct Error]', err);
    return res.status(500).json({ error: '❌ Failed to create product', details: err.message });
  }
});




app.post('/createstore', async (req, res) => {
  try {
    const {
      storeId,       // 👈 take this from frontend
      brandName,
      storeName,
      branchName,
      storeLocation,
      description,
      storeHours,
      contactDetails,
      storeLogo,
      storeBackground,
      ownerId,
      ownerName,
    } = req.body;

    if (!storeId) {
      return res.status(400).json({ error: 'storeId is required from frontend' });
    }

    // Geocode
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    const geoResponse = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address: storeLocation, key: apiKey }
    });

    if (geoResponse.data.status !== 'OK') {
      return res.status(400).json({ error: 'Invalid location for geocoding' });
    }

    const { lat, lng } = geoResponse.data.results[0].geometry.location;

    // ✅ Save store with the SAME storeId
    await db.collection('stores').doc(storeId).set({
      storeId, // 👈 explicitly save it
      brandName,
      storeName,
      branchName,
      storeLocation,
      geoPoint: new admin.firestore.GeoPoint(lat, lng),
      description,
      storeHours,
      contactDetails,
      storeLogo,
      storeBackground,
      ownerId,
      ownerName,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      message: 'Store created successfully',
      storeId,
      geoPoint: { lat, lng },
    });

  } catch (err) {
    console.error('🔥 [CreateStore Error]', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});






app.put('/updatestore/:storeId', async (req, res) => {
  try {
    const { storeId } = req.params;
    const {
      brandName,
      storeName,
      branchName,
      storeLocation,
      description,
      storeHours,
      contactDetails,
      storeLogo,
      storeBackground,
      ownerId,
      ownerName,
    } = req.body;

    if (!storeId) {
      return res.status(400).json({ error: 'storeId is required in URL' });
    }

    const storeRef = db.collection('stores').doc(storeId);
    const storeDoc = await storeRef.get();

    if (!storeDoc.exists) {
      return res.status(404).json({ error: '❌ Store not found' });
    }

    // 🔍 Re-geocode if storeLocation is provided
    let geoPoint = storeDoc.data().geoPoint;
    if (storeLocation) {
      const apiKey = process.env.GOOGLE_MAPS_API_KEY;
      const geoResponse = await axios.get(
        'https://maps.googleapis.com/maps/api/geocode/json',
        { params: { address: storeLocation, key: apiKey } }
      );

      if (geoResponse.data.status === 'OK') {
        const { lat, lng } = geoResponse.data.results[0].geometry.location;
        geoPoint = new admin.firestore.GeoPoint(lat, lng);
      }
    }

    // ✅ Update only provided fields
    await storeRef.update({
      brandName: brandName || storeDoc.data().brandName,
      storeName: storeName || storeDoc.data().storeName,
      branchName: branchName || storeDoc.data().branchName,
      storeLocation: storeLocation || storeDoc.data().storeLocation,
      description: description || storeDoc.data().description,
      storeHours: storeHours || storeDoc.data().storeHours,
      contactDetails: contactDetails || storeDoc.data().contactDetails,
      storeLogo: storeLogo || storeDoc.data().storeLogo,
      storeBackground: storeBackground || storeDoc.data().storeBackground,
      ownerId: ownerId || storeDoc.data().ownerId,
      ownerName: ownerName || storeDoc.data().ownerName,
      geoPoint,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      message: '✅ Store updated successfully',
      storeId,
      geoPoint,
    });

  } catch (err) {
    console.error('🔥 [UpdateStore Error]', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});


// 📝 Update a product
app.put('/updateproduct/:productId', async (req, res) => {
  try {
    const { productId } = req.params;
    const {
      storeId,
      storeName,
      ownerId,
      ownerName,
      brandName,
      categories,
      productDescription,
      productImages,
      variants,
    } = req.body;

    if (!productId) {
      return res.status(400).json({ error: '❌ productId is required in URL' });
    }

    const productRef = db.collection('products').doc(productId);
    const productDoc = await productRef.get();

    if (!productDoc.exists) {
      return res.status(404).json({ error: '❌ Product not found' });
    }

    // ✅ Validate variants if provided
    if (variants && variants.length) {
      for (const v of variants) {
        if (!v.name || !v.stock || !v.price) {
          return res.status(400).json({ error: '❌ Each variant must have name, stock, and price' });
        }
        if (isNaN(v.stock) || Number(v.stock) < 0) {
          return res.status(400).json({ error: `❌ Variant "${v.name}" stock must be a non-negative number` });
        }
        if (isNaN(v.price) || Number(v.price) <= 0) {
          return res.status(400).json({ error: `❌ Variant "${v.name}" price must be a positive number` });
        }
      }
    }

    // ✅ Update only provided fields
    await productRef.update({
      storeId: storeId || productDoc.data().storeId,
      storeName: storeName || productDoc.data().storeName,
      ownerId: ownerId || productDoc.data().ownerId,
      ownerName: ownerName || productDoc.data().ownerName,
      brandName: brandName || productDoc.data().brandName,
      categories: categories || productDoc.data().categories,
      productDescription: productDescription || productDoc.data().productDescription,
      productImages: productImages || productDoc.data().productImages,
      variants: variants
        ? variants.map(v => ({
            name: v.name,
            stock: Number(v.stock),
            price: Number(v.price),
          }))
        : productDoc.data().variants,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      message: '✅ Product updated successfully',
      productId,
    });
  } catch (err) {
    console.error('🔥 [UpdateProduct Error]', err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});




























app.post('/register/buyer', async (req, res) => {
  try {
    console.log('✅ Received data:', req.body);

    const {
      firstName,
      lastName,
      email,
      password,
      role,
      address,
      contactNumber,
      birthday,
      validIdBase64,
      agreedToTerms,
    } = req.body;

    if (!firstName || !lastName || !email || !password || !role) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    let validIdUrl = '';
    let userRecord;

    // ✅ Step 1: Upload Valid ID Image if provided
    if (validIdBase64) {
      const buffer = Buffer.from(validIdBase64, 'base64');
      const safeEmail = email.replace(/[@.]/g, '_');
      const fileName = `valid_ids/temp_${safeEmail}_validID.jpg`; // Use temp name for now
      const file = bucket.file(fileName);

      await file.save(buffer, {
        metadata: { contentType: 'image/jpeg' },
        public: true,
      });

      validIdUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
    }

    // ✅ Step 2: Save user to Firestore
    const tempUID = `temp_${Date.now()}`;
    await db.collection('temp_users').doc(tempUID).set({
      firstName,
      lastName,
      email,
      role,
      status: 'pending',
      address,
      contactNumber,
      birthday,
      validIdUrl,
      agreedToTerms: agreedToTerms,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ✅ Step 3: Only now create Firebase Auth user
    userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: `${firstName} ${lastName}`,
    });

    // ✅ Step 4: Store in main 'users' collection with real UID
    await db.collection('users').doc(userRecord.uid).set({
      uid: userRecord.uid,
      firstName,
      lastName,
      email,
      role,
      status: 'pending',
      address,
      contactNumber,
      birthday,
      validIdUrl,
      agreedToTerms: agreedToTerms,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ✅ Cleanup: delete temp entry
    await db.collection('temp_users').doc(tempUID).delete();

    return res.status(200).json({
      message: 'User registered successfully',
      uid: userRecord.uid,
      imageUrl: validIdUrl,
    });

  } catch (err) {
    console.error('[RegisterBuyer Error]', err);

    if (err.code === 'auth/email-already-exists') {
      return res.status(400).json({ error: 'Email is already in use' });
    }

    return res.status(500).json({ error: 'Internal server error' });
  }
});


app.post('/register/seller', async (req, res) => {
  try {
    console.log('✅ Received data:', req.body);

    const {
      firstName,
      lastName,
      email,
      password,
      role,
      address,
      contactNumber,
      birthday,
      validIdBase64,
      agreedToTerms, // ✅ Base64 image
    } = req.body;

    if (!firstName || !lastName || !email || !password || !role) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
   

    // ✅ Step 1: Create Firebase Auth User
    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: `${firstName} ${lastName}`,
    });

    let validIdUrl = '';

    // ✅ Step 2: Upload Valid ID Image if provided
    if (validIdBase64) {
      const buffer = Buffer.from(validIdBase64, 'base64');

      // 👇 Name format: uid_email_validID.jpg (for traceability)
      const safeEmail = email.replace(/[@.]/g, '_');
      const fileName = `valid_ids/${userRecord.uid}_${safeEmail}_validID.jpg`;
      const file = bucket.file(fileName);

      await file.save(buffer, {
        metadata: { contentType: 'image/jpeg' },
        public: true, // ✅ Make publicly accessible
      });

      validIdUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
    }

    // ✅ Step 3: Save user to Firestore
    await db.collection('users').doc(userRecord.uid).set({
      uid: userRecord.uid,
      firstName,
      lastName,
      email,
      role,
      status: 'pending',
      address,
      contactNumber,
      birthday,
      validIdUrl,
      agreedToTerms: agreedToTerms,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      message: 'User registered successfully',
      uid: userRecord.uid,
      imageUrl: validIdUrl,
    });

  } catch (err) {
    console.error('[RegisterBuyer Error]', err);

    if (err.code === 'auth/email-already-exists') {
      return res.status(400).json({ error: 'Email is already in use' });
    }

    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/register/rider', async (req, res) => {
  try {
    console.log('✅ Received data:', req.body);

    const {
      firstName,
      lastName,
      email,
      password,
      role,
      address,
      vehicle,
      contactNumber,
      birthday,
      validIdBase64,
      agreedToTerms, // ✅ Base64 image
    } = req.body;

    if (!firstName || !lastName || !email || !password || !role) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
   

    // ✅ Step 1: Create Firebase Auth User
    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: `${firstName} ${lastName}`,
    });

    let validIdUrl = '';

    // ✅ Step 2: Upload Valid ID Image if provided
    if (validIdBase64) {
      const buffer = Buffer.from(validIdBase64, 'base64');

      // 👇 Name format: uid_email_validID.jpg (for traceability)
      const safeEmail = email.replace(/[@.]/g, '_');
      const fileName = `valid_ids/${userRecord.uid}_${safeEmail}_validID.jpg`;
      const file = bucket.file(fileName);

      await file.save(buffer, {
        metadata: { contentType: 'image/jpeg' },
        public: true, // ✅ Make publicly accessible
      });

      validIdUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
    }

    // ✅ Step 3: Save user to Firestore
    await db.collection('users').doc(userRecord.uid).set({
      uid: userRecord.uid,
      firstName,
      lastName,
      email,
      role,
      status: 'pending',
      address,
      vehicle,
      contactNumber,
      birthday,
      validIdUrl,
      agreedToTerms: agreedToTerms,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.status(200).json({
      message: 'User registered successfully',
      uid: userRecord.uid,
      imageUrl: validIdUrl,
    });

  } catch (err) {
    console.error('[RegisterBuyer Error]', err);

    if (err.code === 'auth/email-already-exists') {
      return res.status(400).json({ error: 'Email is already in use' });
    }

    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ✅ Start Server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
