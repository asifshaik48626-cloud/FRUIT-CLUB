# Ghouse Fruits - Wholesale Management Portal (Pure Serverless Edition)

A modern, responsive, and secure digital management system built for wholesale fruit agencies. It replaces manual paper ledger systems with a real-time, automated dashboard and provides first-class multi-tenant isolation, role-based controls, and offline test sandbox support.

This application runs on a **Pure Serverless Architecture**, deploying the compiled React frontend to **Cloudflare Pages** and using **Firebase Firestore** as the cloud database engine, completely retiring the need for a Node.js Express server and SQLite database (reducing maintenance costs to $0/month).

---

## 🌎 Live Deployments
* **Production Web App**: [https://ghouse-fruits.pages.dev/](https://ghouse-fruits.pages.dev/)
* **GitHub Repository**: [https://github.com/asifshaik48626-cloud/FRUIT-CLUB](https://github.com/asifshaik48626-cloud/FRUIT-CLUB)

---

## ⚡ Technical Stack & Architecture

- **Frontend Hosting**: **Cloudflare Pages** (providing global edge loading, automatic SSL, and zero server maintenance cost).
- **Frontend Framework**: **React SPA** scaffolded with **Vite** and **TailwindCSS**.
- **Design System**: Structured under the **M3 Material Design System** (integrating colors like `surface-container-lowest`, `primary`, `secondary`, and `outline-variant`).
- **Icons & Typography**: Loaded from Google Fonts (Inter, JetBrains Mono) and **Material Symbols Outlined** for high-fidelity warehouse UI components.
- **Database Engine**: **Firebase Firestore NoSQL Database** (fully managed, auto-scaling, client-side SDK queries).
- **Authentication**: **Firebase Authentication** using **Google Login**. It includes a **Developer Mock Sign-in Mode** for running locally or testing offline without setting up OAuth keys immediately.
- **Serverless Architecture**: Zero API servers to run or host, achieving a maintenance-free hosting architecture.

---

## 🚀 Key Features

### 1. Multi-Tenant Organization Isolation
- All Firestore collections (`users`, `customers`, `fruits`, `sales`, `cashbook`, `payments`) are partitioned with a unique `organization_id`.
- Queries are automatically scoped to the logged-in user's organization, guaranteeing that no tenant can view or modify another tenant's files, balances, sales history, or cashbooks.
- Users signing up independently with Google automatically spin up a new organization dynamically named **"Ghouse fruits"** (if it's the first organization in the system) or **"[User Name]'s fruits"** and join as its **Owner**.

### 2. Strict Role-Based Access Control (RBAC)
- **Owner**: Full access to all components, reports, user registry, database dumps, and cashbook logs. Only Owners can delete customers or fruits.
- **Staff**: Limited operational view. Staff can search customers, view fruit inventory, and record new sales. Restricted tabs (Cash Book, Reports, Backup & Restore, and User Registry) and delete buttons are hidden/disabled in the React UI.

### 3. Client Auto-Seeding
- If an organization's `fruits` and `customers` collections are empty, the frontend automatically seeds them with default Ghouse fruits inventory (Apples, Bananas, Oranges, Mangoes) and mockup clients (Ramesh Kumar, Srinivas Rao, Satish Patel) on first login.

### 4. Bilingual (English & Telugu) Support
- Fully integrated language dictionaries for English (EN) and Telugu (TE), switchable via a toggle button in the top bar.

### 5. custom Sales checkout & FIFO collections
- **Checkout Transactions**: Executed atomically inside a Firestore `runTransaction` to verify and deduct stock, update customer balances, log sale items, and insert upfront payment & cashbook logs.
- **FIFO Payment Allocation**: Automatically reduces customer outstanding balances, allocates payments in First In, First Out order to clear their oldest pending sales, writes payment docs, and logs cashbook entries in a single atomic transaction.

### 6. Accounting Cash Book
- An accounting cash book that computes:
  - **Opening Balance**: Net cash flow prior to the chosen date.
  - **Daily Inflows**: Automatic entries from cash sales and credit payments collected.
  - **Daily Outflows**: Cash spent on purchases or operational expenses.
  - **Closing Balance**: Opening Balance + Daily Inflows - Daily Outflows.
- Operators can manually record expenditures (like diesel, tea, loading/unloading).

### 7. Browser Reports & CSV Exports
- **Excel/CSV Export**: Generates clean CSV string spreadsheets and triggers browser downloads directly from the client for sales, profit, and outstanding balance reports.
- **PDF Printing**: Native browser `@media print` styling prints professional invoices and reports directly.

---

## 🛠️ Local Development & Deployment

### 1. Prerequisite Configuration
Ensure you have a `.env` file in the `frontend` directory containing your Firebase credentials:
```env
VITE_FIREBASE_API_KEY=your-api-key
VITE_FIREBASE_AUTH_DOMAIN=your-auth-domain
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-storage-bucket
VITE_FIREBASE_MESSAGING_SENDER_ID=your-sender-id
VITE_FIREBASE_APP_ID=your-app-id
```

### 2. Start Local Development Server
Run the following in the `frontend` folder:
```bash
# Install dependencies
npm install

# Run the dev server
npm run dev
```

### 3. Build & Deploy to Cloudflare Pages
To build the production assets and deploy them via Wrangler CLI:
```bash
# Compile build folder
npm run build

# Deploy via Wrangler
npx wrangler pages deploy dist --project-name ghouse-fruits --branch main
```

---

## 📜 Firestore Security Rules (Production Config)
Deploy these rules to your Firebase console under **Firestore Database -> Rules** to secure your data:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    
    function isSignedIn() {
      return request.auth != null;
    }
    
    function getUserData() {
      return get(/databases/$(database)/documents/users/$(request.auth.token.email)).data;
    }

    match /users/{email} {
      allow read: if isSignedIn();
      allow create: if isSignedIn() && request.auth.token.email == email;
      allow update: if isSignedIn() && (
        request.auth.token.email == email || 
        getUserData().role == 'owner'
      );
      allow delete: if isSignedIn() && getUserData().role == 'owner';
    }

    match /organizations/{orgId} {
      allow read, write: if isSignedIn();
    }

    match /customers/{docId} {
      allow read, write: if isSignedIn() && (
        (request.method == 'create' && request.resource.data.organization_id == getUserData().organization_id) ||
        (resource.data.organization_id == getUserData().organization_id)
      );
    }
    
    match /fruits/{docId} {
      allow read, write: if isSignedIn() && (
        (request.method == 'create' && request.resource.data.organization_id == getUserData().organization_id) ||
        (resource.data.organization_id == getUserData().organization_id)
      );
    }
    
    match /sales/{docId} {
      allow read, write: if isSignedIn() && (
        (request.method == 'create' && request.resource.data.organization_id == getUserData().organization_id) ||
        (resource.data.organization_id == getUserData().organization_id)
      );
    }
    
    match /cashbook/{docId} {
      allow read, write: if isSignedIn() && (
        (request.method == 'create' && request.resource.data.organization_id == getUserData().organization_id) ||
        (resource.data.organization_id == getUserData().organization_id)
      );
    }
    
    match /payments/{docId} {
      allow read, write: if isSignedIn() && (
        (request.method == 'create' && request.resource.data.organization_id == getUserData().organization_id) ||
        (resource.data.organization_id == getUserData().organization_id)
      );
    }
  }
}
```
