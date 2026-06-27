import React, { useState, useEffect, useRef } from 'react';
import { Chart, registerables } from 'chart.js';
import { translations } from './translations';
import { auth, googleProvider, isMockFirebase, db } from './firebase';
import { signInWithPopup } from 'firebase/auth';
import { 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  setDoc, 
  updateDoc, 
  deleteDoc, 
  query, 
  where, 
  limit, 
  orderBy, 
  runTransaction 
} from 'firebase/firestore';

Chart.register(...registerables);

export default function App() {
  // Session State
  const [token, setToken] = useState(localStorage.getItem('token') || '');
  const [user, setUser] = useState(JSON.parse(localStorage.getItem('user')) || null);
  const [lang, setLang] = useState(localStorage.getItem('lang') || 'en');

  // Navigation
  const [activeTab, setActiveTab] = useState('dashboard');
  const [adminSubTab, setAdminSubTab] = useState('db'); // 'db' or 'users'

  // Data States
  const [customers, setCustomers] = useState([]);
  const [fruits, setFruits] = useState([]);
  const [sales, setSales] = useState([]);
  const [payments, setPayments] = useState([]);
  const [cashbookData, setCashbookData] = useState({ entries: [], openingBalance: 0, dailyIn: 0, dailyOut: 0, closingBalance: 0 });
  const [dashboardData, setDashboardData] = useState(null);
  const [systemUsers, setSystemUsers] = useState([]); // List of portal users
  
  // Filtering & Search
  const [searchQuery, setSearchQuery] = useState('');
  const [cashbookDate, setCashbookDate] = useState(new Date().toISOString().split('T')[0]);

  // Auth States
  const [mockEmailInput, setMockEmailInput] = useState('owner@bussinessclub.com');
  const [showMockLoginModal, setShowMockLoginModal] = useState(false);
  const [showCustomMockInput, setShowCustomMockInput] = useState(false);
  const [loginError, setLoginError] = useState('');

  // Modals States
  const [activeModal, setActiveModal] = useState(null); 
  const [selectedItem, setSelectedItem] = useState(null);
  
  // Toast Notification
  const [toast, setToast] = useState(null);

  // Forms Binding
  const [custForm, setCustForm] = useState({ name: '', phone: '', address: '' });
  const [fruitForm, setFruitForm] = useState({ name: '', quantity_available: '', purchase_price: '', selling_price: '', min_stock_alert: '', image_url: '' });
  const [payForm, setPayForm] = useState({ amount_paid: '', payment_method: 'Cash', notes: '' });
  const [cashForm, setCashForm] = useState({ type: 'cash_out', amount: '', category: 'expense', description: '' });
  const [userForm, setUserForm] = useState({ email: '', name: '', role: 'staff' });

  // Sales Entry cart state
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [salesItems, setSalesItems] = useState([]);
  const [currentSalesItem, setCurrentSalesItem] = useState({ fruit_id: '', quantity: '', price: '' });
  const [salesPaidAmount, setSalesPaidAmount] = useState('0');
  const [salesDueDate, setSalesDueDate] = useState('');
  const [salesNotes, setSalesNotes] = useState('');

  // Reports
  const [reportType, setReportType] = useState('daily');
  const [reportStartDate, setReportStartDate] = useState(new Date().toISOString().split('T')[0]);
  const [reportEndDate, setReportEndDate] = useState(new Date().toISOString().split('T')[0]);
  const [reportResult, setReportResult] = useState(null);

  // Backup
  const [backupFile, setBackupFile] = useState(null);

  // Chart refs
  const salesChartRef = useRef(null);
  const fruitsChartRef = useRef(null);
  const salesChartInst = useRef(null);
  const fruitsChartInst = useRef(null);

  // Translate helper
  const t = (key) => translations[lang][key] || key;

  // Show toast
  const showToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const handleLogout = () => {
    setToken('');
    setUser(null);
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  };

  // Authenticate user via Firestore (supports real Google Auth and mock local profiles)
  const authenticateFirestoreUser = async (firebaseUser, mockEmail = null) => {
    setLoginError('');
    try {
      let email, name, uid;
      if (mockEmail) {
        email = mockEmail;
        name = mockEmail.split('@')[0];
        uid = 'mock-' + name;
      } else {
        email = firebaseUser.email;
        name = firebaseUser.displayName || email.split('@')[0];
        uid = firebaseUser.uid;
      }

      if (!email) {
        throw new Error('No verified email found.');
      }

      // Check if user exists in Firestore
      const userDocRef = doc(db, 'users', email);
      const userDoc = await getDoc(userDocRef);
      let userData;

      if (!userDoc.exists()) {
        // Bootstrap new organization
        const orgsSnapshot = await getDocs(collection(db, 'organizations'));
        const count = orgsSnapshot.size;
        const orgName = count === 0 ? 'BUSSINESS CLUB' : `${name}'s fruits`;

        const orgDocRef = doc(collection(db, 'organizations'));
        const orgId = orgDocRef.id;
        await setDoc(orgDocRef, {
          id: orgId,
          name: orgName,
          created_at: new Date().toISOString()
        });

        userData = {
          email,
          firebase_uid: uid,
          role: 'owner',
          name,
          status: 'active',
          organization_id: orgId,
          organization_name: orgName,
          created_at: new Date().toISOString()
        };
        await setDoc(userDocRef, userData);
      } else {
        userData = userDoc.data();
        if (!userData.firebase_uid) {
          await updateDoc(userDocRef, { firebase_uid: uid });
          userData.firebase_uid = uid;
        }
      }

      if (userData.status !== 'active') {
        throw new Error('This user account is deactivated');
      }

      // Auto-seed default fruits/customers if they are empty for this organization
      await checkAndSeedData(userData.organization_id);

      const sessionToken = 'session-token-' + email;
      setToken(sessionToken);
      setUser(userData);
      localStorage.setItem('token', sessionToken);
      localStorage.setItem('user', JSON.stringify(userData));
      showToast(`Welcome, ${userData.name}!`);
    } catch (err) {
      console.error("Authentication error:", err);
      setLoginError(err.message || 'Authentication failed.');
      throw err;
    }
  };

  // Seed default inventory and mockup customers if organization has none
  const checkAndSeedData = async (orgId) => {
    try {
      const fruitsQ = query(collection(db, 'fruits'), where('organization_id', '==', orgId));
      const fruitsSnap = await getDocs(fruitsQ);
      if (fruitsSnap.empty) {
        const defaultFruits = [
          { name: 'Apple', quantity_available: 50, purchase_price: 120, selling_price: 160, min_stock_alert: 10, image_url: '' },
          { name: 'Banana', quantity_available: 100, purchase_price: 40, selling_price: 60, min_stock_alert: 15, image_url: '' },
          { name: 'Orange', quantity_available: 75, purchase_price: 80, selling_price: 110, min_stock_alert: 10, image_url: '' },
          { name: 'Mango', quantity_available: 30, purchase_price: 150, selling_price: 200, min_stock_alert: 5, image_url: '' }
        ];
        for (const item of defaultFruits) {
          const docRef = doc(collection(db, 'fruits'));
          await setDoc(docRef, { ...item, id: docRef.id, organization_id: orgId, created_at: new Date().toISOString() });
        }
      }

      const custsQ = query(collection(db, 'customers'), where('organization_id', '==', orgId));
      const custsSnap = await getDocs(custsQ);
      if (custsSnap.empty) {
        const defaultCustomers = [
          { name: 'Ramesh Kumar', phone: '9876543210', address: 'Guntur', balance_due: 0 },
          { name: 'Srinivas Rao', phone: '8765432109', address: 'Vijayawada', balance_due: 0 },
          { name: 'Satish Patel', phone: '7654321098', address: 'Hyderabad', balance_due: 0 }
        ];
        for (const item of defaultCustomers) {
          const docRef = doc(collection(db, 'customers'));
          await setDoc(docRef, { ...item, id: docRef.id, organization_id: orgId, created_at: new Date().toISOString() });
        }
      }
    } catch (err) {
      console.error("Auto-seeding error:", err);
    }
  };

  // Trigger Google Sign-In Popup
  const handleGoogleLogin = async () => {
    if (isMockFirebase) {
      setShowMockLoginModal(true);
      return;
    }
    try {
      const result = await signInWithPopup(auth, googleProvider);
      await authenticateFirestoreUser(result.user);
    } catch (err) {
      console.error("Google Sign-In Error:", err);
      setLoginError(err.message || 'Google Auth Popup closed or failed.');
    }
  };

  const handleMockLoginSubmit = async (e) => {
    e.preventDefault();
    setShowMockLoginModal(false);
    try {
      await authenticateFirestoreUser(null, mockEmailInput);
    } catch (err) {
      setLoginError(err.message || 'Mock Sign In failed.');
    }
  };

  const handleQuickMockLogin = async (email) => {
    try {
      await authenticateFirestoreUser(null, email);
    } catch (err) {
      setLoginError(err.message || 'Mock Sign In failed.');
    }
  };

  const loadDashboard = async () => {
    if (!user) return;
    try {
      const customersQ = query(collection(db, 'customers'), where('organization_id', '==', user.organization_id));
      const customersSnapshot = await getDocs(customersQ);
      const customersList = [];
      customersSnapshot.forEach(docSnap => {
        customersList.push({ id: docSnap.id, ...docSnap.data() });
      });

      const fruitsQ = query(collection(db, 'fruits'), where('organization_id', '==', user.organization_id));
      const fruitsSnapshot = await getDocs(fruitsQ);
      const fruitsList = [];
      fruitsSnapshot.forEach(docSnap => {
        fruitsList.push({ id: docSnap.id, ...docSnap.data() });
      });

      const salesQ = query(collection(db, 'sales'), where('organization_id', '==', user.organization_id));
      const salesSnapshot = await getDocs(salesQ);
      const salesList = [];
      salesSnapshot.forEach(docSnap => {
        salesList.push({ id: docSnap.id, ...docSnap.data() });
      });

      const todayStr = new Date().toISOString().split('T')[0];
      const startOfToday = `${todayStr}T00:00:00`;
      const endOfToday = `${todayStr}T23:59:59.999`;

      let totalSalesToday = 0;
      salesList.forEach(sale => {
        if (sale.sale_date >= startOfToday && sale.sale_date <= endOfToday) {
          totalSalesToday += parseFloat(sale.total_amount || 0);
        }
      });

      const totalCustomers = customersList.length;

      let pendingPayments = 0;
      customersList.forEach(cust => {
        pendingPayments += parseFloat(cust.balance_due || 0);
      });

      let totalStock = 0;
      fruitsList.forEach(f => {
        totalStock += parseFloat(f.quantity_available || 0);
      });

      const recentTransactions = [...salesList]
        .sort((a, b) => (b.sale_date || '').localeCompare(a.sale_date || ''))
        .slice(0, 5)
        .map(s => {
          const cust = customersList.find(c => c.id === s.customer_id);
          return {
            ...s,
            customer_name: cust ? cust.name : (s.customer_name || 'Unknown'),
            customer_phone: cust ? cust.phone : ''
          };
        });

      const lowStockFruits = fruitsList
        .filter(f => parseFloat(f.quantity_available) <= parseFloat(f.min_stock_alert))
        .sort((a, b) => parseFloat(a.quantity_available) - parseFloat(b.quantity_available));

      const weeklySales = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dStr = d.toISOString().split('T')[0];
        const start = `${dStr}T00:00:00`;
        const end = `${dStr}T23:59:59.999`;

        let total = 0;
        salesList.forEach(sale => {
          if (sale.sale_date >= start && sale.sale_date <= end) {
            total += parseFloat(sale.total_amount || 0);
          }
        });

        weeklySales.push({
          date: dStr,
          label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          total
        });
      }

      const fruitSalesMap = {};
      salesList.forEach(sale => {
        if (sale.items && Array.isArray(sale.items)) {
          sale.items.forEach(item => {
            const fName = item.fruit_name || 'Unknown';
            if (!fruitSalesMap[fName]) {
              fruitSalesMap[fName] = { quantity: 0, revenue: 0 };
            }
            fruitSalesMap[fName].quantity += parseFloat(item.quantity || 0);
            fruitSalesMap[fName].revenue += parseFloat(item.total || 0);
          });
        }
      });

      const topFruits = Object.keys(fruitSalesMap)
        .map(name => ({
          name,
          quantity: fruitSalesMap[name].quantity,
          revenue: fruitSalesMap[name].revenue
        }))
        .sort((a, b) => b.quantity - a.quantity)
        .slice(0, 5);

      setDashboardData({
        kpis: {
          totalSalesToday,
          totalCustomers,
          pendingPayments,
          totalStock
        },
        recentTransactions,
        lowStockFruits,
        charts: {
          weeklySales,
          topFruits
        }
      });
    } catch (err) {
      console.error("Error loading dashboard metrics:", err);
      showToast("Error loading dashboard data", "error");
    }
  };

  const loadCustomers = async (search = '') => {
    if (!user) return;
    try {
      const q = query(
        collection(db, 'customers'),
        where('organization_id', '==', user.organization_id)
      );
      const snapshot = await getDocs(q);
      let list = [];
      snapshot.forEach(docSnap => {
        list.push({ id: docSnap.id, ...docSnap.data() });
      });
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

      if (search) {
        const lowerSearch = search.toLowerCase();
        list = list.filter(c => 
          (c.name || '').toLowerCase().includes(lowerSearch) ||
          (c.phone || '').includes(lowerSearch) ||
          (c.address || '').toLowerCase().includes(lowerSearch)
        );
      }
      setCustomers(list);
    } catch (err) {
      console.error("Error loading customers:", err);
      showToast("Error loading customers", "error");
    }
  };

  const loadFruits = async (search = '') => {
    if (!user) return;
    try {
      const q = query(
        collection(db, 'fruits'),
        where('organization_id', '==', user.organization_id)
      );
      const snapshot = await getDocs(q);
      let list = [];
      snapshot.forEach(docSnap => {
        list.push({ id: docSnap.id, ...docSnap.data() });
      });
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

      if (search) {
        const lowerSearch = search.toLowerCase();
        list = list.filter(f => (f.name || '').toLowerCase().includes(lowerSearch));
      }
      setFruits(list);
    } catch (err) {
      console.error("Error loading fruits:", err);
      showToast("Error loading fruits", "error");
    }
  };

  const loadCashbook = async (date) => {
    if (!user) return;
    try {
      const q = query(
        collection(db, 'cashbook'),
        where('organization_id', '==', user.organization_id)
      );
      const snapshot = await getDocs(q);
      const list = [];
      snapshot.forEach(docSnap => {
        list.push({ id: docSnap.id, ...docSnap.data() });
      });

      const targetDate = date || new Date().toISOString().split('T')[0];
      const startOfDay = `${targetDate}T00:00:00`;
      const endOfDay = `${targetDate}T23:59:59.999`;

      let openingBalance = 0;
      let dailyIn = 0;
      let dailyOut = 0;
      const dailyEntries = [];

      list.forEach(entry => {
        const entryDate = entry.entry_date;
        const amt = parseFloat(entry.amount || 0);

        if (entryDate < startOfDay) {
          if (entry.type === 'cash_in') {
            openingBalance += amt;
          } else if (entry.type === 'cash_out') {
            openingBalance -= amt;
          }
        } else if (entryDate >= startOfDay && entryDate <= endOfDay) {
          dailyEntries.push(entry);
          if (entry.type === 'cash_in') {
            dailyIn += amt;
          } else if (entry.type === 'cash_out') {
            dailyOut += amt;
          }
        }
      });

      dailyEntries.sort((a, b) => a.entry_date.localeCompare(b.entry_date));
      const closingBalance = openingBalance + dailyIn - dailyOut;

      setCashbookData({
        entries: dailyEntries,
        openingBalance,
        dailyIn,
        dailyOut,
        closingBalance
      });
    } catch (err) {
      console.error("Error loading cashbook:", err);
      showToast("Error loading cashbook", "error");
    }
  };

  const loadUsers = async () => {
    if (user?.role !== 'owner') return;
    try {
      const q = query(
        collection(db, 'users'),
        where('organization_id', '==', user.organization_id)
      );
      const snapshot = await getDocs(q);
      const list = [];
      snapshot.forEach(docSnap => {
        list.push({ id: docSnap.id, ...docSnap.data() });
      });
      setSystemUsers(list);
    } catch (err) {
      console.error("Error loading users:", err);
    }
  };

  // Sync active Tab
  useEffect(() => {
    if (!token) return;
    if (activeTab === 'dashboard') {
      loadDashboard();
    } else if (activeTab === 'inventory') {
      loadFruits(searchQuery);
    } else if (activeTab === 'customers') {
      loadCustomers(searchQuery);
    } else if (activeTab === 'sales-entry') {
      loadCustomers();
      loadFruits();
    } else if (activeTab === 'cashbook') {
      loadCashbook(cashbookDate);
    } else if (activeTab === 'reports') {
      setReportResult(null);
    } else if (activeTab === 'backup') {
      if (adminSubTab === 'users') {
        loadUsers();
      }
    }
  }, [token, activeTab, adminSubTab, searchQuery, cashbookDate]);

  // Toggle Language
  const toggleLanguage = () => {
    const nextLang = lang === 'en' ? 'te' : 'en';
    setLang(nextLang);
    localStorage.setItem('lang', nextLang);
  };

  // Draw Charts
  useEffect(() => {
    if (activeTab === 'dashboard' && dashboardData && salesChartRef.current && fruitsChartRef.current) {
      const salesCtx = salesChartRef.current.getContext('2d');
      if (salesChartInst.current) salesChartInst.current.destroy();
      salesChartInst.current = new Chart(salesCtx, {
        type: 'line',
        data: {
          labels: dashboardData.charts.weeklySales.map(d => d.label),
          datasets: [{
            label: t('revenue'),
            data: dashboardData.charts.weeklySales.map(d => d.total),
            borderColor: '#006e1c', 
            backgroundColor: 'rgba(0, 110, 28, 0.08)',
            fill: true,
            tension: 0.3,
            borderWidth: 3
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            y: { beginAtZero: true, grid: { color: '#eceeec' } },
            x: { grid: { display: false } }
          }
        }
      });

      const fruitsCtx = fruitsChartRef.current.getContext('2d');
      if (fruitsChartInst.current) fruitsChartInst.current.destroy();
      fruitsChartInst.current = new Chart(fruitsCtx, {
        type: 'bar',
        data: {
          labels: dashboardData.charts.topFruits.map(f => f.name),
          datasets: [{
            label: t('qtySold'),
            data: dashboardData.charts.topFruits.map(f => f.quantity),
            backgroundColor: ['#fb8c00', '#4caf50', '#8b5000', '#0061a4', '#ba1a1a'],
            borderRadius: 8
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            y: { beginAtZero: true, grid: { color: '#eceeec' } },
            x: { grid: { display: false } }
          }
        }
      });
    }
    return () => {
      if (salesChartInst.current) salesChartInst.current.destroy();
      if (fruitsChartInst.current) fruitsChartInst.current.destroy();
    };
  }, [dashboardData, activeTab, lang]);

  // Customer Actions
  const handleSaveCustomer = async (e) => {
    e.preventDefault();
    try {
      if (activeModal === 'add-customer') {
        const docRef = doc(collection(db, 'customers'));
        await setDoc(docRef, {
          id: docRef.id,
          name: custForm.name,
          phone: custForm.phone,
          address: custForm.address,
          balance_due: 0,
          organization_id: user.organization_id,
          created_at: new Date().toISOString()
        });
        showToast('Customer added successfully!');
      } else if (activeModal === 'edit-customer') {
        const docRef = doc(db, 'customers', selectedItem.id);
        await updateDoc(docRef, {
          name: custForm.name,
          phone: custForm.phone,
          address: custForm.address
        });
        showToast('Customer details updated!');
      }
      setActiveModal(null);
      loadCustomers(searchQuery);
    } catch (err) {
      console.error("Save customer error:", err);
      showToast("Failed to save customer", "error");
    }
  };

  const openEditCustomer = (cust) => {
    setCustForm({ name: cust.name, phone: cust.phone, address: cust.address || '' });
    setSelectedItem(cust);
    setActiveModal('edit-customer');
  };

  const handleDeleteCustomer = async (custId) => {
    if (!window.confirm(t('confirmDeleteCust'))) return;
    try {
      await deleteDoc(doc(db, 'customers', custId));
      showToast('Customer removed.');
      loadCustomers(searchQuery);
    } catch (err) {
      console.error("Delete customer error:", err);
      showToast("Failed to delete customer", "error");
    }
  };

  const openLedger = async (cust) => {
    try {
      const salesQ = query(
        collection(db, 'sales'),
        where('customer_id', '==', cust.id),
        where('organization_id', '==', user.organization_id)
      );
      const salesSnap = await getDocs(salesQ);
      const salesList = [];
      salesSnap.forEach(docSnap => {
        salesList.push({ id: docSnap.id, ...docSnap.data() });
      });
      salesList.sort((a, b) => (b.sale_date || '').localeCompare(a.sale_date || ''));

      const paymentsQ = query(
        collection(db, 'payments'),
        where('customer_id', '==', cust.id)
      );
      const paymentsSnap = await getDocs(paymentsQ);
      const paymentsList = [];
      paymentsSnap.forEach(docSnap => {
        paymentsList.push({ id: docSnap.id, ...docSnap.data() });
      });
      paymentsList.sort((a, b) => (b.payment_date || '').localeCompare(a.payment_date || ''));

      setSelectedItem({
        customer: cust,
        sales: salesList,
        payments: paymentsList
      });
      setActiveModal('view-ledger');
    } catch (err) {
      console.error("Open ledger error:", err);
      showToast("Failed to load customer ledger", "error");
    }
  };

  const openRecordPayment = (cust) => {
    setSelectedItem(cust);
    setPayForm({ amount_paid: '', payment_method: 'Cash', notes: '' });
    setActiveModal('record-payment');
  };

  const handleRecordPayment = async (e) => {
    e.preventDefault();
    if (!payForm.amount_paid) {
      showToast('Please specify a payment amount', 'error');
      return;
    }
    const payAmt = parseFloat(payForm.amount_paid);
    if (payAmt <= 0) {
      showToast('Payment amount must be greater than 0', 'error');
      return;
    }

    try {
      const q = query(
        collection(db, 'sales'),
        where('customer_id', '==', selectedItem.id),
        where('status', 'in', ['pending', 'partially_paid']),
        where('organization_id', '==', user.organization_id)
      );
      const salesSnap = await getDocs(q);
      const pendingSalesIds = [];
      salesSnap.forEach(docSnap => {
        pendingSalesIds.push(docSnap.id);
      });

      await runTransaction(db, async (transaction) => {
        const customerRef = doc(db, 'customers', selectedItem.id);
        const customerDoc = await transaction.get(customerRef);
        if (!customerDoc.exists()) {
          throw new Error('Customer not found');
        }
        const customerData = customerDoc.data();
        const currentBalance = parseFloat(customerData.balance_due || 0);
        if (currentBalance <= 0) {
          throw new Error('Customer has no outstanding balance');
        }

        const finalPayAmt = Math.min(payAmt, currentBalance);

        const salesDocs = [];
        for (const id of pendingSalesIds) {
          const sRef = doc(db, 'sales', id);
          const sSnap = await transaction.get(sRef);
          if (sSnap.exists()) {
            salesDocs.push({ id, ref: sRef, data: sSnap.data() });
          }
        }

        salesDocs.sort((a, b) => (a.data.sale_date || '').localeCompare(b.data.sale_date || ''));

        transaction.update(customerRef, { balance_due: currentBalance - finalPayAmt });

        let remainingPayment = finalPayAmt;
        for (const sale of salesDocs) {
          if (remainingPayment <= 0) break;

          const saleDue = parseFloat(sale.data.balance_due || 0);
          const paymentToApply = Math.min(remainingPayment, saleDue);

          const newPaidAmount = parseFloat(sale.data.paid_amount || 0) + paymentToApply;
          const newBalanceDue = saleDue - paymentToApply;
          const newStatus = newBalanceDue <= 0 ? 'paid' : 'partially_paid';

          transaction.update(sale.ref, {
            paid_amount: newPaidAmount,
            balance_due: newBalanceDue,
            status: newStatus
          });

          const pRef = doc(collection(db, 'payments'));
          transaction.set(pRef, {
            id: pRef.id,
            customer_id: selectedItem.id,
            sale_id: sale.id,
            amount_paid: paymentToApply,
            payment_method: payForm.payment_method || 'Cash',
            notes: `Invoice payment allocation. ${payForm.notes || ''}`.trim(),
            payment_date: new Date().toISOString(),
            organization_id: user.organization_id
          });

          remainingPayment -= paymentToApply;
        }

        if (remainingPayment > 0 || salesDocs.length === 0) {
          const pRef = doc(collection(db, 'payments'));
          transaction.set(pRef, {
            id: pRef.id,
            customer_id: selectedItem.id,
            sale_id: null,
            amount_paid: remainingPayment,
            payment_method: payForm.payment_method || 'Cash',
            notes: `General credit payment. ${payForm.notes || ''}`.trim(),
            payment_date: new Date().toISOString(),
            organization_id: user.organization_id
          });
        }

        const cashbookRef = doc(collection(db, 'cashbook'));
        transaction.set(cashbookRef, {
          id: cashbookRef.id,
          type: 'cash_in',
          amount: finalPayAmt,
          category: 'payment',
          description: `Received credit payment from ${customerData.name} via ${payForm.payment_method || 'Cash'}`,
          created_by: user.name,
          organization_id: user.organization_id,
          entry_date: new Date().toISOString()
        });
      });

      showToast('Payment recorded and ledger updated.');
      setActiveModal(null);
      loadCustomers(searchQuery);
    } catch (err) {
      console.error("Record payment error:", err);
      showToast(err.message || "Failed to record payment", "error");
    }
  };

  // Fruit Actions
  const handleSaveFruit = async (e) => {
    e.preventDefault();
    try {
      if (activeModal === 'add-fruit') {
        const docRef = doc(collection(db, 'fruits'));
        await setDoc(docRef, {
          id: docRef.id,
          name: fruitForm.name,
          quantity_available: parseFloat(fruitForm.quantity_available || 0),
          purchase_price: parseFloat(fruitForm.purchase_price || 0),
          selling_price: parseFloat(fruitForm.selling_price || 0),
          min_stock_alert: parseFloat(fruitForm.min_stock_alert || 10),
          image_url: fruitForm.image_url || '',
          organization_id: user.organization_id,
          created_at: new Date().toISOString()
        });
        showToast('Fruit added to database.');
      } else if (activeModal === 'edit-fruit') {
        const docRef = doc(db, 'fruits', selectedItem.id);
        await updateDoc(docRef, {
          name: fruitForm.name,
          quantity_available: parseFloat(fruitForm.quantity_available || 0),
          purchase_price: parseFloat(fruitForm.purchase_price || 0),
          selling_price: parseFloat(fruitForm.selling_price || 0),
          min_stock_alert: parseFloat(fruitForm.min_stock_alert || 10),
          image_url: fruitForm.image_url || ''
        });
        showToast('Fruit details updated.');
      }
      setActiveModal(null);
      loadFruits(searchQuery);
    } catch (err) {
      console.error("Save fruit error:", err);
      showToast("Failed to save fruit", "error");
    }
  };

  const openEditFruit = (fruit) => {
    setSelectedItem(fruit);
    setFruitForm({
      name: fruit.name,
      quantity_available: fruit.quantity_available,
      purchase_price: fruit.purchase_price,
      selling_price: fruit.selling_price,
      min_stock_alert: fruit.min_stock_alert,
      image_url: fruit.image_url || ''
    });
    setActiveModal('edit-fruit');
  };

  const handleDeleteFruit = async (fruitId) => {
    if (!window.confirm('Delete this fruit?')) return;
    try {
      await deleteDoc(doc(db, 'fruits', fruitId));
      showToast('Fruit removed.');
      loadFruits(searchQuery);
    } catch (err) {
      console.error("Delete fruit error:", err);
      showToast("Failed to delete fruit", "error");
    }
  };

  // User Actions (Admin only user list modifications)
  const handleAddUser = async (e) => {
    e.preventDefault();
    try {
      const email = userForm.email;
      const docRef = doc(db, 'users', email);
      const existsSnap = await getDoc(docRef);
      if (existsSnap.exists()) {
        showToast('User email already registered', 'error');
        return;
      }
      await setDoc(docRef, {
        email,
        name: userForm.name,
        role: userForm.role,
        status: 'active',
        organization_id: user.organization_id,
        organization_name: user.organization_name,
        created_at: new Date().toISOString()
      });
      showToast('User email registered successfully!');
      setUserForm({ email: '', name: '', role: 'staff' });
      loadUsers();
    } catch (err) {
      console.error("Add user error:", err);
      showToast("Failed to register user", "error");
    }
  };

  const handleUpdateUserRole = async (targetUser, role) => {
    try {
      const docRef = doc(db, 'users', targetUser.email);
      await updateDoc(docRef, { role });
      showToast('User role updated.');
      loadUsers();
    } catch (err) {
      console.error("Update user role error:", err);
    }
  };

  const handleToggleUserStatus = async (targetUser) => {
    const nextStatus = targetUser.status === 'active' ? 'inactive' : 'active';
    try {
      const docRef = doc(db, 'users', targetUser.email);
      await updateDoc(docRef, { status: nextStatus });
      showToast(`User account status set to ${nextStatus}.`);
      loadUsers();
    } catch (err) {
      console.error("Toggle user status error:", err);
    }
  };

  const handleDeleteUser = async (userId) => {
    if (!window.confirm('Are you sure you want to remove this user email registration?')) return;
    try {
      await deleteDoc(doc(db, 'users', userId));
      showToast('User account registration deleted.');
      loadUsers();
    } catch (err) {
      console.error("Delete user error:", err);
    }
  };

  // Sales Entry Actions
  const handleAddSalesItem = () => {
    const { fruit_id, quantity, price } = currentSalesItem;
    if (!fruit_id || !quantity || parseFloat(quantity) <= 0) {
      showToast('Select a fruit and type a quantity', 'error');
      return;
    }
    const fruit = fruits.find(f => f.id === fruit_id);
    if (!fruit) return;

    const qty = parseFloat(quantity);
    const itemPrice = parseFloat(price || fruit.selling_price);

    if (parseFloat(fruit.quantity_available) < qty) {
      showToast(`Stock limit exceeded! Only ${fruit.quantity_available} Kgs available`, 'error');
      return;
    }

    const existsIdx = salesItems.findIndex(item => item.fruit_id === fruit.id);
    if (existsIdx > -1) {
      const updated = [...salesItems];
      updated[existsIdx].quantity += qty;
      updated[existsIdx].total = updated[existsIdx].quantity * updated[existsIdx].price;
      setSalesItems(updated);
    } else {
      setSalesItems([
        ...salesItems,
        {
          fruit_id: fruit.id,
          fruit_name: fruit.name,
          quantity: qty,
          price: itemPrice,
          total: qty * itemPrice
        }
      ]);
    }
    setCurrentSalesItem({ fruit_id: '', quantity: '', price: '' });
  };

  const handleRemoveSalesItem = (idx) => {
    const updated = [...salesItems];
    updated.splice(idx, 1);
    setSalesItems(updated);
  };

  const calculateSalesTotal = () => salesItems.reduce((sum, item) => sum + item.total, 0);

  const handleSaveSale = async () => {
    if (!selectedCustomerId) {
      showToast('Please select a customer first', 'error');
      return;
    }
    if (salesItems.length === 0) {
      showToast('Please add items to your cart', 'error');
      return;
    }

    const paid = parseFloat(salesPaidAmount || 0);

    try {
      const saleId = await runTransaction(db, async (transaction) => {
        const customerRef = doc(db, 'customers', selectedCustomerId);
        const customerDoc = await transaction.get(customerRef);
        if (!customerDoc.exists()) {
          throw new Error("Customer does not exist");
        }
        const customerData = customerDoc.data();

        const fruitRefs = salesItems.map(item => doc(db, 'fruits', item.fruit_id));
        const fruitDocs = [];
        for (const ref of fruitRefs) {
          const docSnap = await transaction.get(ref);
          if (!docSnap.exists()) {
            throw new Error(`Fruit ${ref.id} not found`);
          }
          fruitDocs.push({ id: docSnap.id, ref, data: docSnap.data() });
        }

        let totalAmount = 0;
        const verifiedItems = [];

        for (let i = 0; i < salesItems.length; i++) {
          const item = salesItems[i];
          const fruit = fruitDocs.find(f => f.id === item.fruit_id);
          const stockAvailable = parseFloat(fruit.data.quantity_available || 0);
          const reqQty = parseFloat(item.quantity);

          if (stockAvailable < reqQty) {
            throw new Error(`Insufficient stock for ${fruit.data.name}. Available: ${stockAvailable}, Requested: ${reqQty}`);
          }

          const price = parseFloat(item.price || fruit.data.selling_price);
          const itemTotal = reqQty * price;
          totalAmount += itemTotal;

          verifiedItems.push({
            fruit_id: item.fruit_id,
            fruit_name: fruit.data.name,
            quantity: reqQty,
            price,
            total: itemTotal
          });
        }

        const balanceDue = totalAmount - paid;
        let status = 'pending';
        if (balanceDue <= 0) {
          status = 'paid';
        } else if (paid > 0) {
          status = 'partially_paid';
        }

        const saleRef = doc(collection(db, 'sales'));
        const newSaleId = saleRef.id;

        transaction.set(saleRef, {
          id: newSaleId,
          customer_id: selectedCustomerId,
          customer_name: customerData.name,
          total_amount: totalAmount,
          paid_amount: paid,
          balance_due: balanceDue,
          due_date: salesDueDate || null,
          status,
          created_by: user.name,
          notes: salesNotes || '',
          organization_id: user.organization_id,
          sale_date: new Date().toISOString(),
          items: verifiedItems
        });

        for (let i = 0; i < verifiedItems.length; i++) {
          const item = verifiedItems[i];
          const fruit = fruitDocs.find(f => f.id === item.fruit_id);
          const newQty = parseFloat(fruit.data.quantity_available) - item.quantity;
          transaction.update(fruit.ref, { quantity_available: newQty });
        }

        if (balanceDue > 0) {
          const newCustBalance = parseFloat(customerData.balance_due || 0) + balanceDue;
          transaction.update(customerRef, { balance_due: newCustBalance });
        }

        if (paid > 0) {
          const paymentRef = doc(collection(db, 'payments'));
          transaction.set(paymentRef, {
            id: paymentRef.id,
            customer_id: selectedCustomerId,
            sale_id: newSaleId,
            amount_paid: paid,
            payment_method: 'Cash',
            notes: `Advance payment for sale invoice #${newSaleId}`,
            payment_date: new Date().toISOString(),
            organization_id: user.organization_id
          });

          const cashbookRef = doc(collection(db, 'cashbook'));
          transaction.set(cashbookRef, {
            id: cashbookRef.id,
            type: 'cash_in',
            amount: paid,
            category: 'sale',
            description: `Upfront payment for sale invoice #${newSaleId} - ${customerData.name}`,
            created_by: user.name,
            organization_id: user.organization_id,
            entry_date: new Date().toISOString()
          });
        }

        return newSaleId;
      });

      showToast('Invoice generated successfully!');

      const docRef = doc(db, 'sales', saleId);
      const saleSnap = await getDoc(docRef);
      if (saleSnap.exists()) {
        const saleData = saleSnap.data();
        setSelectedItem({
          sale: saleData,
          items: saleData.items
        });
        setActiveModal('print-invoice');
      }

      setSelectedCustomerId('');
      setSalesItems([]);
      setSalesPaidAmount('0');
      setSalesDueDate('');
      setSalesNotes('');
    } catch (err) {
      console.error("Checkout transaction failed:", err);
      showToast(err.message || 'Error processing checkout', 'error');
    }
  };

  // Cashbook manual entries
  const handleSaveCashEntry = async (e) => {
    e.preventDefault();
    if (!cashForm.amount) {
      showToast('Amount is required', 'error');
      return;
    }
    try {
      const docRef = doc(collection(db, 'cashbook'));
      await setDoc(docRef, {
        id: docRef.id,
        type: cashForm.type,
        amount: parseFloat(cashForm.amount),
        category: cashForm.category,
        description: cashForm.description || '',
        created_by: user.name,
        organization_id: user.organization_id,
        entry_date: new Date().toISOString()
      });
      showToast('Entry logged in cash book.');
      setActiveModal(null);
      loadCashbook(cashbookDate);
      setCashForm({ type: 'cash_out', amount: '', category: 'expense', description: '' });
    } catch (err) {
      console.error("Save cash entry error:", err);
      showToast("Failed to save entry", "error");
    }
  };

  // Report generation
  const handleGenerateReport = async () => {
    if (!user) return;
    try {
      let startDate = reportStartDate;
      let endDate = reportEndDate;
      const today = new Date();
      const formatDateStr = (date) => date.toISOString().split('T')[0];

      if (reportType === 'daily') {
        startDate = formatDateStr(today);
        endDate = formatDateStr(today);
      } else if (reportType === 'weekly') {
        const prevWeek = new Date();
        prevWeek.setDate(today.getDate() - 7);
        startDate = formatDateStr(prevWeek);
        endDate = formatDateStr(today);
      } else if (reportType === 'monthly') {
        const prevMonth = new Date();
        prevMonth.setMonth(today.getMonth() - 1);
        startDate = formatDateStr(prevMonth);
        endDate = formatDateStr(today);
      }

      const startOfPeriod = `${startDate}T00:00:00`;
      const endOfPeriod = `${endDate}T23:59:59.999`;

      if (reportType === 'outstanding') {
        const q = query(
          collection(db, 'customers'),
          where('balance_due', '>', 0),
          where('organization_id', '==', user.organization_id)
        );
        const snap = await getDocs(q);
        const list = [];
        snap.forEach(docSnap => {
          list.push({ id: docSnap.id, ...docSnap.data() });
        });
        list.sort((a, b) => b.balance_due - a.balance_due);
        setReportResult({
          reportType: 'outstanding',
          data: list
        });
        return;
      }

      if (reportType === 'profit') {
        const fruitsSnap = await getDocs(query(collection(db, 'fruits'), where('organization_id', '==', user.organization_id)));
        const fruitsMap = {};
        fruitsSnap.forEach(docSnap => {
          fruitsMap[docSnap.id] = docSnap.data();
        });

        const salesSnap = await getDocs(query(collection(db, 'sales'), where('organization_id', '==', user.organization_id)));
        const reportData = [];
        let totalRevenue = 0;
        let totalCost = 0;
        let totalProfit = 0;

        salesSnap.forEach(docSnap => {
          const sale = docSnap.data();
          if (sale.sale_date >= startOfPeriod && sale.sale_date <= endOfPeriod) {
            if (sale.items && Array.isArray(sale.items)) {
              sale.items.forEach(item => {
                const fruit = fruitsMap[item.fruit_id] || { purchase_price: 0 };
                const costPrice = parseFloat(fruit.purchase_price || 0);
                const costTotal = costPrice * parseFloat(item.quantity);
                const profitAmount = parseFloat(item.total) - costTotal;

                totalRevenue += parseFloat(item.total);
                totalCost += costTotal;
                totalProfit += profitAmount;

                reportData.push({
                  sale_id: sale.id,
                  sale_date: sale.sale_date,
                  customer_name: sale.customer_name || 'Unknown',
                  fruit_name: item.fruit_name || 'Unknown',
                  quantity: item.quantity,
                  sale_price: item.price,
                  cost_price: costPrice,
                  sale_total: item.total,
                  cost_total: costTotal,
                  profit_amount: profitAmount
                });
              });
            }
          }
        });

        reportData.sort((a, b) => b.sale_date.localeCompare(a.sale_date));

        setReportResult({
          reportType: 'profit',
          startDate,
          endDate,
          summary: { totalRevenue, totalCost, totalProfit },
          data: reportData
        });
        return;
      }

      const salesSnap = await getDocs(query(collection(db, 'sales'), where('organization_id', '==', user.organization_id)));
      const reportData = [];
      let totalAmount = 0;
      let totalPaid = 0;
      let totalDues = 0;

      salesSnap.forEach(docSnap => {
        const sale = docSnap.data();
        if (sale.sale_date >= startOfPeriod && sale.sale_date <= endOfPeriod) {
          totalAmount += parseFloat(sale.total_amount || 0);
          totalPaid += parseFloat(sale.paid_amount || 0);
          totalDues += parseFloat(sale.balance_due || 0);

          reportData.push({
            id: sale.id,
            sale_date: sale.sale_date,
            customer_name: sale.customer_name,
            total_amount: sale.total_amount,
            paid_amount: sale.paid_amount,
            balance_due: sale.balance_due,
            status: sale.status
          });
        }
      });

      reportData.sort((a, b) => b.sale_date.localeCompare(a.sale_date));

      setReportResult({
        reportType: reportType || 'custom',
        startDate,
        endDate,
        summary: { totalAmount, totalPaid, totalDues },
        data: reportData
      });
    } catch (err) {
      console.error("Generate report error:", err);
      showToast("Error generating report", "error");
    }
  };

  const handleExportExcel = () => {
    if (!reportResult || !reportResult.data || reportResult.data.length === 0) {
      showToast('No data to export', 'error');
      return;
    }

    let csvContent = "";
    let filename = `Report_${reportType || 'custom'}_${new Date().toISOString().split('T')[0]}.csv`;

    if (reportResult.reportType === 'outstanding') {
      csvContent += "Customer Name,Phone,Address,Outstanding Balance (Rs)\n";
      reportResult.data.forEach(item => {
        csvContent += `"${item.name}","${item.phone}","${item.address || ''}",${parseFloat(item.balance_due).toFixed(2)}\n`;
      });
    } else if (reportResult.reportType === 'profit') {
      csvContent += "Date,Customer,Fruit,Quantity (Kg),Cost Price (Rs),Sale Price (Rs),Total Cost (Rs),Revenue (Rs),Net Profit (Rs)\n";
      reportResult.data.forEach(item => {
        csvContent += `"${new Date(item.sale_date).toLocaleDateString()}","${item.customer_name}","${item.fruit_name}",${parseFloat(item.quantity).toFixed(2)},${parseFloat(item.cost_price).toFixed(2)},${parseFloat(item.sale_price).toFixed(2)},${parseFloat(item.cost_total).toFixed(2)},${parseFloat(item.sale_total).toFixed(2)},${parseFloat(item.profit_amount).toFixed(2)}\n`;
      });
    } else {
      csvContent += "Invoice ID,Date,Customer,Total Amount (Rs),Paid Amount (Rs),Balance Due (Rs),Status\n";
      reportResult.data.forEach(sale => {
        csvContent += `"#${sale.id}","${new Date(sale.sale_date).toLocaleDateString()}","${sale.customer_name}",${parseFloat(sale.total_amount).toFixed(2)},${parseFloat(sale.paid_amount).toFixed(2)},${parseFloat(sale.balance_due).toFixed(2)},"${sale.status}"\n`;
      });
    }

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('Report exported successfully as CSV!');
  };

  const handleExportPdfReport = () => {
    if (!reportResult || reportResult.data.length === 0) {
      showToast('No data to export', 'error');
      return;
    }
    window.print();
  };

  // Backup & Restore
  const handleBackupExport = async () => {
    if (!user) return;
    try {
      showToast('Preparing backup data...');
      const custSnap = await getDocs(query(collection(db, 'customers'), where('organization_id', '==', user.organization_id)));
      const customers = [];
      custSnap.forEach(d => customers.push(d.data()));

      const fruitSnap = await getDocs(query(collection(db, 'fruits'), where('organization_id', '==', user.organization_id)));
      const fruits = [];
      fruitSnap.forEach(d => fruits.push(d.data()));

      const salesSnap = await getDocs(query(collection(db, 'sales'), where('organization_id', '==', user.organization_id)));
      const sales = [];
      salesSnap.forEach(d => sales.push(d.data()));

      const cashSnap = await getDocs(query(collection(db, 'cashbook'), where('organization_id', '==', user.organization_id)));
      const cashbook = [];
      cashSnap.forEach(d => cashbook.push(d.data()));

      const userSnap = await getDocs(query(collection(db, 'users'), where('organization_id', '==', user.organization_id)));
      const users = [];
      userSnap.forEach(d => users.push(d.data()));

      const backupObj = {
        organization_id: user.organization_id,
        organization_name: user.organization_name,
        backup_date: new Date().toISOString(),
        customers,
        fruits,
        sales,
        cashbook,
        users
      };

      const jsonStr = JSON.stringify(backupObj, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `GhouseFruits_Backup_${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      showToast(t('backupExportSuccess'));
    } catch (err) {
      console.error("Backup export error:", err);
      showToast("Failed to export backup data", "error");
    }
  };

  const handleBackupRestore = async (e) => {
    e.preventDefault();
    if (!backupFile) {
      showToast('Select a file to restore', 'error');
      return;
    }

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const backupData = JSON.parse(event.target.result);
        if (!backupData.customers || !backupData.fruits || !backupData.sales) {
          showToast('Invalid backup file format', 'error');
          return;
        }

        showToast('Restoring backup data...');

        const custSnap = await getDocs(query(collection(db, 'customers'), where('organization_id', '==', user.organization_id)));
        for (const docSnap of custSnap.docs) {
          await deleteDoc(doc(db, 'customers', docSnap.id));
        }

        const fruitSnap = await getDocs(query(collection(db, 'fruits'), where('organization_id', '==', user.organization_id)));
        for (const docSnap of fruitSnap.docs) {
          await deleteDoc(doc(db, 'fruits', docSnap.id));
        }

        const salesSnap = await getDocs(query(collection(db, 'sales'), where('organization_id', '==', user.organization_id)));
        for (const docSnap of salesSnap.docs) {
          await deleteDoc(doc(db, 'sales', docSnap.id));
        }

        const cashSnap = await getDocs(query(collection(db, 'cashbook'), where('organization_id', '==', user.organization_id)));
        for (const docSnap of cashSnap.docs) {
          await deleteDoc(doc(db, 'cashbook', docSnap.id));
        }

        const paySnap = await getDocs(query(collection(db, 'payments'), where('organization_id', '==', user.organization_id)));
        for (const docSnap of paySnap.docs) {
          await deleteDoc(doc(db, 'payments', docSnap.id));
        }

        const userSnap = await getDocs(query(collection(db, 'users'), where('organization_id', '==', user.organization_id)));
        for (const docSnap of userSnap.docs) {
          if (docSnap.id !== user.email) {
            await deleteDoc(doc(db, 'users', docSnap.id));
          }
        }

        for (const item of backupData.customers || []) {
          await setDoc(doc(db, 'customers', item.id), {
            ...item,
            organization_id: user.organization_id
          });
        }

        for (const item of backupData.fruits || []) {
          await setDoc(doc(db, 'fruits', item.id), {
            ...item,
            organization_id: user.organization_id
          });
        }

        for (const item of backupData.sales || []) {
          await setDoc(doc(db, 'sales', item.id), {
            ...item,
            organization_id: user.organization_id
          });
        }

        for (const item of backupData.cashbook || []) {
          await setDoc(doc(db, 'cashbook', item.id), {
            ...item,
            organization_id: user.organization_id
          });
        }

        for (const item of backupData.payments || []) {
          await setDoc(doc(db, 'payments', item.id), {
            ...item,
            organization_id: user.organization_id
          });
        }

        for (const item of backupData.users || []) {
          if (item.email !== user.email) {
            await setDoc(doc(db, 'users', item.email), {
              ...item,
              organization_id: user.organization_id,
              organization_name: user.organization_name
            });
          }
        }

        showToast(t('backupSuccess'));
        setBackupFile(null);
        loadDashboard();
      } catch (err) {
        console.error("Backup restore failed:", err);
        showToast('Invalid backup JSON format', 'error');
      }
    };
    reader.readAsText(backupFile);
  };

  const sendWhatsAppReminder = (cust) => {
    const cleanedPhone = cust.phone.replace(/[^0-9]/g, '');
    const phoneWithCountry = cleanedPhone.startsWith('91') ? cleanedPhone : `91${cleanedPhone}`;
    const message = `Dear ${cust.name}, this is a credit due reminder from BUSSINESS CLUB. Your current outstanding balance is Rs. ${parseFloat(cust.balance_due).toFixed(2)}. Please arrange for a timely clearance. Thank you!`;
    const waUrl = `https://wa.me/${phoneWithCountry}?text=${encodeURIComponent(message)}`;
    window.open(waUrl, '_blank');
  };

  return (
    <div className="min-h-screen bg-background text-on-surface flex flex-col font-sans relative">
      {/* Toast Alert */}
      {toast && (
        <div className={`fixed top-4 right-4 z-[100] px-5 py-3.5 rounded-xl shadow-xl transition-all duration-300 flex items-center gap-3 font-semibold text-white ${
          toast.type === 'error' ? 'bg-error' : 'bg-primary'
        }`}>
          <span className="material-symbols-outlined">{toast.type === 'error' ? 'error' : 'check_circle'}</span>
          <span>{toast.message}</span>
        </div>
      )}

      {/* 1. LOGIN PAGE */}
      {!token ? (
        <div className="flex-1 min-h-screen flex items-center justify-center p-gutter bg-gradient-to-tr from-[#1E4D2B] via-[#0E2F1A] to-[#E67E22] relative overflow-hidden">
          {/* Subtle background glow bubbles for advanced styling */}
          <div className="absolute w-72 h-72 bg-primary/20 rounded-full blur-3xl -top-12 -left-12 animate-pulse"></div>
          <div className="absolute w-80 h-80 bg-secondary/15 rounded-full blur-3xl -bottom-16 -right-16 animate-pulse" style={{ animationDelay: '2s' }}></div>

          <div className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl rounded-3xl p-8 md:p-12 shadow-2xl max-w-md w-full animate-fade-in relative border border-white/20 z-10 transition-all duration-300">
            <div className="flex flex-col items-center mb-8">
              <div className="w-16 h-16 bg-[#1E4D2B]/10 text-[#1E4D2B] rounded-2xl flex items-center justify-center shadow-md mb-4 border border-[#1E4D2B]/10">
                <span className="material-symbols-outlined text-[38px] text-[#1E4D2B]" style={{ fontVariationSettings: "'FILL' 1" }}>forest</span>
              </div>
              <h2 className="text-3xl font-black text-slate-800 tracking-tight text-center">BUSSINESS CLUB</h2>
              <p className="text-[10px] text-primary font-bold mt-1 uppercase tracking-widest">Wholesale Portal Dues Log</p>
            </div>

            {loginError && (
              <div className="mb-6 p-4 bg-error-container text-on-error-container rounded-xl text-xs font-semibold flex items-center gap-2">
                <span className="material-symbols-outlined text-[16px]">warning</span>
                <span>{loginError}</span>
              </div>
            )}

            <div className="space-y-6">
              {isMockFirebase ? (
                <>
                  <div className="p-4 bg-[#1E4D2B]/5 text-[#1E4D2B] rounded-2xl border border-[#1E4D2B]/10">
                    <p className="text-[11px] text-center font-bold leading-relaxed">
                      💡 **Developer Sandbox Active**<br />
                      OAuth is bypassed. Click a profile card below to sign in instantly:
                    </p>
                  </div>

                  <div className="space-y-3.5">
                    {/* Owner Card */}
                    <button
                      onClick={() => handleQuickMockLogin('owner@ghousefruits.com')}
                      className="w-full flex items-center justify-between p-4 bg-white/50 hover:bg-[#1E4D2B]/5 border border-[#1E4D2B]/10 hover:border-[#1E4D2B] text-slate-800 rounded-2xl transition-all duration-150 shadow-sm active:scale-[0.98] group"
                    >
                      <div className="flex items-center gap-3.5">
                        <div className="w-11 h-11 rounded-xl bg-[#1E4D2B] text-white flex items-center justify-center shadow-md shrink-0 group-hover:scale-105 transition-transform">
                          <span className="material-symbols-outlined text-[22px]">admin_panel_settings</span>
                        </div>
                        <div className="text-left">
                          <p className="text-xs font-black text-slate-800">Login as Owner</p>
                          <p className="text-[10px] text-slate-500 font-mono mt-0.5">owner@ghousefruits.com</p>
                        </div>
                      </div>
                      <span className="material-symbols-outlined text-[#1E4D2B] text-[20px] group-hover:translate-x-0.5 transition-transform">chevron_right</span>
                    </button>

                    {/* Staff Card */}
                    <button
                      onClick={() => handleQuickMockLogin('staff@ghousefruits.com')}
                      className="w-full flex items-center justify-between p-4 bg-white/50 hover:bg-[#E67E22]/5 border border-[#E67E22]/10 hover:border-[#E67E22] text-slate-800 rounded-2xl transition-all duration-150 shadow-sm active:scale-[0.98] group"
                    >
                      <div className="flex items-center gap-3.5">
                        <div className="w-11 h-11 rounded-xl bg-[#E67E22] text-white flex items-center justify-center shadow-md shrink-0 group-hover:scale-105 transition-transform">
                          <span className="material-symbols-outlined text-[22px]">badge</span>
                        </div>
                        <div className="text-left">
                          <p className="text-xs font-black text-slate-800">Login as Operational Staff</p>
                          <p className="text-[10px] text-slate-500 font-mono mt-0.5">staff@ghousefruits.com</p>
                        </div>
                      </div>
                      <span className="material-symbols-outlined text-[#E67E22] text-[20px] group-hover:translate-x-0.5 transition-transform">chevron_right</span>
                    </button>
                  </div>

                  {showCustomMockInput ? (
                    <form onSubmit={handleMockLoginSubmit} className="space-y-3 pt-4 border-t border-slate-200">
                      <div>
                        <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Custom Developer Email</label>
                        <div className="flex gap-2">
                          <input
                            type="email"
                            className="flex-1 px-4 py-2.5 border border-slate-200 bg-white rounded-xl text-xs font-semibold focus:outline-none focus:border-[#1E4D2B] text-slate-800 shadow-inner"
                            placeholder="e.g. name@gmail.com"
                            value={mockEmailInput}
                            onChange={(e) => setMockEmailInput(e.target.value)}
                            required
                          />
                          <button
                            type="submit"
                            className="px-4 bg-[#1E4D2B] hover:bg-[#0E2F1A] text-white text-xs font-bold rounded-xl transition-all shadow-sm"
                          >
                            Sign In
                          </button>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowCustomMockInput(false)}
                        className="text-[10px] text-slate-400 font-bold underline block mx-auto hover:text-[#1E4D2B]"
                      >
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowCustomMockInput(true)}
                      className="text-xs text-[#1E4D2B] font-bold text-center block w-full hover:underline pt-2"
                    >
                      Or sign in with custom mock email
                    </button>
                  )}
                </>
              ) : (
                <>
                  <p className="text-xs text-on-surface-variant text-center leading-normal">
                    🔒 This portal requires secure Google Authentication to sign in.
                  </p>
                  <button
                    onClick={handleGoogleLogin}
                    className="w-full flex items-center justify-center gap-3 py-4 bg-white border border-outline-variant hover:bg-slate-50 text-slate-700 font-bold rounded-xl transition-all active:scale-95 duration-100 shadow-md text-sm"
                  >
                    <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" width="24" height="24" xmlns="http://www.w3.org/2000/svg">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05"/>
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335"/>
                    </svg>
                    <span>Sign in with Google</span>
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* 2. AUTHENTICATED SYSTEM LAYOUT */
        <>
          {/* TopAppBar */}
          <header className="no-print w-full top-0 sticky z-40 bg-surface border-b border-outline-variant shadow-sm shrink-0">
            <div className="flex justify-between items-center px-gutter py-2 w-full max-w-container-max mx-auto">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full overflow-hidden border border-outline-variant bg-surface-container-low flex items-center justify-center shrink-0">
                  <img 
                    className="w-full h-full object-cover" 
                    alt="User headshot"
                    src="https://lh3.googleusercontent.com/aida-public/AB6AXuCWxercrfxVuI93f7q-Yke9f_9Qg3dxqCLavMz-WOVBW_3dpvdKwiDCQXXHGYBzGUqxFJ1xd4XUnQT-kSjmNIvKKqViEFNxAUEV5ZI0rqdW2SU0ALk6JaV1Dv2drBNb95lreIk8X-8ONOaP6w3ZHozjrBgKTVZIKVhlxyZ5zJcelwTOGrctC4bRgeIsFtpUkaMu5dRkzmsld_3N1W8b6xJtzG8rcvBeBAyb9pJ_EljgGJzHpCDY8iOo2-tVxdlMrTiee_AHxIupMgiW" 
                  />
                </div>
                <h1 className="text-headline-md font-headline-md font-bold text-primary">{user?.organization_name || 'BUSSINESS CLUB'}</h1>
              </div>

              {/* Desktop Nav cluster */}
              <nav className="hidden md:flex items-center gap-6">
                {[
                  { id: 'dashboard', label: t('dashboard') },
                  { id: 'inventory', label: t('inventory') },
                  { id: 'customers', label: t('customers') },
                  { id: 'sales-entry', label: t('salesEntry') },
                  ...(user?.role === 'owner' ? [
                    { id: 'cashbook', label: t('cashbook') },
                    { id: 'reports', label: t('reports') },
                    { id: 'backup', label: t('backup') }
                  ] : [])
                ].map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => { setActiveTab(tab.id); setSearchQuery(''); }}
                    className={`transition-all px-3 py-1 rounded-lg text-sm font-semibold ${
                      activeTab === tab.id 
                        ? 'text-primary font-bold bg-primary/10' 
                        : 'text-on-surface-variant hover:bg-surface-container-high'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </nav>

              <div className="flex items-center gap-2">
                <span className="hidden sm:inline-block px-3 py-1.5 rounded-full bg-surface-container font-mono text-[10px] uppercase font-bold text-slate-600">
                  {user?.email}
                </span>
                
                {/* Language Switch */}
                <button 
                  onClick={toggleLanguage}
                  className="p-2 rounded-full hover:bg-surface-container-high transition-colors active:scale-95 duration-100 flex items-center gap-1 text-on-surface-variant"
                  title="Switch Language / భాష మార్చండి"
                >
                  <span className="material-symbols-outlined">globe</span>
                  <span className="text-xs font-bold uppercase">{lang}</span>
                </button>

                <button 
                  onClick={handleLogout}
                  className="material-symbols-outlined text-on-surface-variant hover:bg-surface-container-high p-2 rounded-full transition-colors active:scale-95 duration-100"
                  title="Logout"
                >
                  logout
                </button>
              </div>
            </div>
          </header>

          <div className="flex flex-1 w-full max-w-container-max mx-auto relative">
            {/* Sidebar drawer (Desktop Only) */}
            <aside className="no-print hidden lg:flex flex-col h-auto w-[280px] bg-surface border-r border-outline-variant py-4 sticky top-[64px] shrink-0">
              <div className="px-6 mb-6">
                <p className="text-label-sm font-label-sm text-outline uppercase tracking-wider">Shift Controls</p>
              </div>

              <nav className="flex flex-col gap-1 px-2">
                {[
                  { id: 'dashboard', label: t('dashboard'), icon: 'dashboard' },
                  { id: 'inventory', label: t('inventory'), icon: 'inventory_2' },
                  { id: 'customers', label: t('customers'), icon: 'group' },
                  { id: 'sales-entry', label: t('salesEntry'), icon: 'receipt_long' },
                  ...(user?.role === 'owner' ? [
                    { id: 'cashbook', label: t('cashbook'), icon: 'book' },
                    { id: 'reports', label: t('reports'), icon: 'analytics' },
                    { id: 'backup', label: t('backup'), icon: 'database' }
                  ] : [])
                ].map(item => {
                  const isActive = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => { setActiveTab(item.id); setSearchQuery(''); }}
                      className={`flex items-center gap-3 px-4 py-3 mx-2 rounded-lg transition-all text-sm font-semibold ${
                        isActive 
                          ? 'bg-secondary-container text-on-secondary-container font-bold' 
                          : 'text-on-surface-variant hover:bg-surface-container-high'
                      }`}
                    >
                      <span className="material-symbols-outlined">{item.icon}</span>
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </nav>

              <div className="mt-auto px-6 border-t border-outline-variant pt-6">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-8 h-8 rounded bg-primary-container flex items-center justify-center text-on-primary-container shadow-inner">
                    <span className="material-symbols-outlined text-[18px]">verified_user</span>
                  </div>
                  <div>
                    <p className="text-body-md font-bold text-on-surface truncate max-w-32">{user?.name}</p>
                    <p className="text-xs text-on-surface-variant uppercase tracking-wider font-semibold">{user?.role} Shift</p>
                  </div>
                </div>
                <p className="text-[10px] text-outline font-label-sm">VERSION 2.4.0</p>
              </div>
            </aside>

            {/* Main Canvas Area */}
            <main className="flex-1 min-w-0 p-gutter pb-32 md:pb-8">
              
              {/* ======================================================== */}
              {/* TAB 1: DASHBOARD */}
              {/* ======================================================== */}
              {activeTab === 'dashboard' && dashboardData && (
                <div className="space-y-8 animate-fade-in no-print">
                  {/* Title & Filter */}
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                      <h2 className="font-headline-lg text-headline-lg text-on-surface tracking-tight">Wholesale Dashboard</h2>
                      <p className="text-body-md text-on-surface-variant">Real-time summaries and operational records</p>
                    </div>
                  </div>

                  {/* Quick Actions Deck */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 no-print">
                    <button 
                      onClick={() => { setActiveTab('sales-entry'); setSearchQuery(''); }}
                      className="bg-primary/5 hover:bg-primary/10 border border-primary/20 hover:border-primary p-4 rounded-2xl flex items-center gap-3.5 transition-all text-left shadow-sm active:scale-95 group"
                    >
                      <div className="w-12 h-12 rounded-xl bg-primary text-on-primary flex items-center justify-center shadow-md shadow-primary/20 shrink-0 group-hover:scale-105 transition-transform">
                        <span className="material-symbols-outlined text-[24px]">shopping_cart_checkout</span>
                      </div>
                      <div>
                        <p className="text-xs font-bold text-on-surface">Record a Sale</p>
                        <p className="text-[10px] text-outline mt-0.5">Bill custom fruit sales</p>
                      </div>
                    </button>

                    <button 
                      onClick={() => { setActiveTab('customers'); setActiveModal('add-customer'); }}
                      className="bg-secondary/5 hover:bg-secondary/10 border border-secondary/20 hover:border-secondary p-4 rounded-2xl flex items-center gap-3.5 transition-all text-left shadow-sm active:scale-95 group"
                    >
                      <div className="w-12 h-12 rounded-xl bg-secondary text-on-secondary flex items-center justify-center shadow-md shadow-secondary/20 shrink-0 group-hover:scale-105 transition-transform">
                        <span className="material-symbols-outlined text-[24px]">person_add</span>
                      </div>
                      <div>
                        <p className="text-xs font-bold text-on-surface">Add Customer</p>
                        <p className="text-[10px] text-outline mt-0.5">Register credit client</p>
                      </div>
                    </button>

                    <button 
                      onClick={() => { setActiveTab('inventory'); setActiveModal('add-fruit'); }}
                      className="bg-[#1E4D2B]/5 hover:bg-[#1E4D2B]/10 border border-[#1E4D2B]/20 hover:border-[#1E4D2B] p-4 rounded-2xl flex items-center gap-3.5 transition-all text-left shadow-sm active:scale-95 group"
                    >
                      <div className="w-12 h-12 rounded-xl bg-[#1E4D2B] text-white flex items-center justify-center shadow-md shrink-0 group-hover:scale-105 transition-transform">
                        <span className="material-symbols-outlined text-[24px]">add_shopping_cart</span>
                      </div>
                      <div>
                        <p className="text-xs font-bold text-on-surface">Add Fruit Stock</p>
                        <p className="text-[10px] text-outline mt-0.5">Restock produce logs</p>
                      </div>
                    </button>

                    <button 
                      onClick={() => { setActiveTab('cashbook'); setActiveModal('add-cash'); }}
                      className="bg-error/5 hover:bg-error/10 border border-error/25 hover:border-error p-4 rounded-2xl flex items-center gap-3.5 transition-all text-left shadow-sm active:scale-95 group"
                    >
                      <div className="w-12 h-12 rounded-xl bg-error text-on-error flex items-center justify-center shadow-md shadow-error/20 shrink-0 group-hover:scale-105 transition-transform">
                        <span className="material-symbols-outlined text-[24px]">payments</span>
                      </div>
                      <div>
                        <p className="text-xs font-bold text-on-surface">Record Expense</p>
                        <p className="text-[10px] text-outline mt-0.5">Log cash book outflows</p>
                      </div>
                    </button>
                  </div>

                  {/* Stats Overview */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <div className="bg-surface-container-low border border-outline-variant p-5 rounded-xl shadow-sm flex flex-col justify-between">
                      <span className="text-label-sm font-label-sm text-on-surface-variant mb-1 uppercase tracking-tight">{t('salesToday')}</span>
                      <p className="text-headline-lg font-bold text-primary font-mono">Rs {dashboardData.kpis.totalSalesToday.toFixed(2)}</p>
                    </div>
                    <div className="bg-surface-container-low border border-outline-variant p-5 rounded-xl shadow-sm flex flex-col justify-between">
                      <span className="text-label-sm font-label-sm text-on-surface-variant mb-1 uppercase tracking-tight">{t('totalCustomers')}</span>
                      <p className="text-headline-lg font-bold text-on-surface font-mono">{dashboardData.kpis.totalCustomers}</p>
                    </div>
                    <div className="bg-surface-container-low border border-outline-variant p-5 rounded-xl shadow-sm flex flex-col justify-between">
                      <span className="text-label-sm font-label-sm text-on-surface-variant mb-1 uppercase tracking-tight">{t('pendingPayments')}</span>
                      <p className="text-headline-lg font-bold text-secondary font-mono">Rs {dashboardData.kpis.pendingPayments.toFixed(2)}</p>
                    </div>
                    <div className="bg-surface-container-low border border-outline-variant p-5 rounded-xl shadow-sm flex flex-col justify-between">
                      <span className="text-label-sm font-label-sm text-on-surface-variant mb-1 uppercase tracking-tight">{t('stockAvailable')}</span>
                      <p className="text-headline-lg font-bold text-on-surface font-mono">{dashboardData.kpis.totalStock.toFixed(1)} Kg</p>
                    </div>
                  </div>

                  {/* Graphs Grid */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-5 shadow-sm flex flex-col">
                      <h4 className="font-bold text-on-surface text-base mb-4 flex items-center gap-2">
                        <span className="w-2.5 h-2.5 bg-primary rounded-full"></span>
                        {t('salesTrend')}
                      </h4>
                      <div className="h-64 relative flex-1">
                        <canvas ref={salesChartRef}></canvas>
                      </div>
                    </div>

                    <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-5 shadow-sm flex flex-col">
                      <h4 className="font-bold text-on-surface text-base mb-4 flex items-center gap-2">
                        <span className="w-2.5 h-2.5 bg-secondary-container rounded-full"></span>
                        {t('topFruits')}
                      </h4>
                      <div className="h-64 relative flex-1">
                        <canvas ref={fruitsChartRef}></canvas>
                      </div>
                    </div>
                  </div>

                  {/* Alerts and Recent lists */}
                  <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
                    <div className="bg-surface-container-lowest border border-outline-variant p-6 rounded-xl shadow-sm flex flex-col xl:col-span-1">
                      <h4 className="font-bold text-on-surface text-base mb-4 flex items-center gap-2 text-error">
                        <span className="material-symbols-outlined text-error">warning</span>
                        {t('lowStockAlert')}
                      </h4>
                      <div className="flex-1 overflow-y-auto space-y-3 max-h-72 pr-1 custom-scrollbar">
                        {dashboardData.lowStockFruits.length === 0 ? (
                          <p className="py-8 text-center text-on-surface-variant font-medium text-xs">{t('stockOk')}</p>
                        ) : (
                          dashboardData.lowStockFruits.map(fruit => (
                            <div key={fruit.id} className="flex justify-between items-center p-3.5 bg-error-container/20 rounded-xl border border-error/20">
                              <div>
                                <span className="font-bold text-on-surface text-sm">{fruit.name}</span>
                                <p className="text-[9px] text-outline font-bold uppercase mt-0.5">Alert limit: {fruit.min_stock_alert} Kg</p>
                              </div>
                              <span className="px-3 py-1 bg-error-container text-on-error-container font-extrabold text-xs rounded-full">
                                {fruit.quantity_available} Kg
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    <div className="bg-surface-container-lowest border border-outline-variant p-6 rounded-xl shadow-sm flex flex-col xl:col-span-2">
                      <h4 className="font-bold text-on-surface text-base mb-4">
                        {t('recentSales')}
                      </h4>
                      <div className="overflow-x-auto flex-1 max-h-72 custom-scrollbar">
                        <table className="w-full text-left border-collapse text-xs">
                          <thead>
                            <tr className="border-b border-outline-variant text-outline font-bold uppercase">
                              <th className="py-3 px-2">Invoice</th>
                              <th className="py-3 px-2">Customer</th>
                              <th className="py-3 px-2">Date</th>
                              <th className="py-3 px-2 text-right">Total (Rs)</th>
                              <th className="py-3 px-2 text-center">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {dashboardData.recentTransactions.map(tx => (
                              <tr key={tx.id} className="border-b border-outline-variant/30 hover:bg-surface-container-low transition-colors text-sm">
                                <td className="py-3.5 px-2 font-bold text-primary">#{tx.id}</td>
                                <td className="py-3.5 px-2 font-bold">{tx.customer_name}</td>
                                <td className="py-3.5 px-2 text-on-surface-variant">{new Date(tx.sale_date).toLocaleDateString()}</td>
                                <td className="py-3.5 px-2 text-right font-bold font-mono">Rs {parseFloat(tx.total_amount).toFixed(2)}</td>
                                <td className="py-3.5 px-2 text-center">
                                  <span className={`px-2.5 py-0.5 rounded-full font-bold text-[10px] uppercase ${
                                    tx.status === 'paid' ? 'bg-primary-container/20 text-primary' :
                                    tx.status === 'partially_paid' ? 'bg-secondary-container/20 text-secondary' : 'bg-error-container/20 text-error'
                                  }`}>
                                    {tx.status}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ======================================================== */}
              {/* TAB 2: INVENTORY */}
              {/* ======================================================== */}
              {activeTab === 'inventory' && (
                <div className="space-y-6 animate-fade-in no-print">
                  <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
                    <div>
                      <h2 className="font-headline-lg text-headline-lg text-on-surface">{t('inventoryList')}</h2>
                      <p className="text-on-surface-variant mt-1">Stock monitoring, alerts and price parameters</p>
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="relative w-full md:w-64">
                        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline">search</span>
                        <input
                          type="text"
                          className="w-full pl-10 pr-4 py-2 bg-surface-container-low border border-outline-variant rounded-xl focus:outline-none focus:border-primary transition-colors text-sm font-semibold"
                          placeholder="Search fruits..."
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                        />
                      </div>
                      <button 
                        onClick={() => {
                          setFruitForm({ name: '', quantity_available: '', purchase_price: '', selling_price: '', min_stock_alert: '', image_url: '' });
                          setActiveModal('add-fruit');
                        }}
                        className="px-4 py-2 bg-primary text-on-primary font-bold rounded-lg hover:opacity-90 active:scale-95 transition-all flex items-center gap-1.5 shadow-sm text-sm"
                      >
                        <span className="material-symbols-outlined text-[18px]">add</span>
                        <span>{t('addFruit')}</span>
                      </button>
                    </div>
                  </div>

                  {/* Bento Grid Fruit Cards */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                    {fruits.map(fruit => {
                      const stockVal = parseFloat(fruit.quantity_available);
                      const minStock = parseFloat(fruit.min_stock_alert);
                      const percent = Math.min(100, Math.max(0, (stockVal / (minStock * 3)) * 100)); 
                      const isLow = stockVal <= minStock;

                      return (
                        <div key={fruit.id} className={`group bg-surface-container-lowest border rounded-xl overflow-hidden hover:shadow-lg transition-all duration-300 ${
                          isLow ? 'border-error/30' : 'border-outline-variant'
                        }`}>
                          <div className="h-40 relative bg-surface-container-low flex items-center justify-center text-slate-300">
                            {fruit.image_url ? (
                              <img 
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" 
                                alt={fruit.name}
                                src={fruit.image_url} 
                              />
                            ) : (
                              <span className="material-symbols-outlined text-[64px]" style={{ fontVariationSettings: "'FILL' 0" }}>apple</span>
                            )}
                            <span className="absolute top-3 left-3 bg-white/90 backdrop-blur-sm px-3 py-1 rounded-full text-xs font-bold text-on-surface border border-outline-variant/30">
                              Wholesale
                            </span>
                          </div>

                          <div className="p-4">
                            <div className="flex justify-between items-start mb-4">
                              <div>
                                <h3 className="font-headline-md text-on-surface text-base">{fruit.name}</h3>
                                <p className="text-[10px] text-on-surface-variant font-label-sm uppercase">SKU: FRT-00{fruit.id}</p>
                              </div>
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                isLow ? 'bg-error-container/20 text-error' : 'bg-primary-container/20 text-primary'
                              }`}>
                                {isLow ? 'LOW STOCK' : 'IN STOCK'}
                              </span>
                            </div>

                            {/* Stock Bar */}
                            <div className="mb-6">
                              <div className="flex justify-between items-center mb-1 text-xs font-semibold">
                                <span className="text-on-surface-variant">Stock: {stockVal.toFixed(1)} Kg</span>
                                <span className={isLow ? 'text-error font-bold' : 'text-primary font-bold'}>{Math.round(percent)}%</span>
                              </div>
                              <div className="w-full bg-surface-container-high h-2 rounded-full overflow-hidden">
                                <div 
                                  className={`h-full rounded-full transition-all duration-500 ${isLow ? 'bg-error' : 'bg-primary'}`} 
                                  style={{ width: `${percent}%` }}
                                ></div>
                              </div>
                            </div>

                            {/* Price */}
                            <div className="grid grid-cols-2 gap-4 pt-4 border-t border-outline-variant/50">
                              <div>
                                <p className="text-[10px] text-outline font-label-sm uppercase">Cost</p>
                                <p className="font-label-sm text-on-surface text-sm font-semibold">Rs {parseFloat(fruit.purchase_price).toFixed(2)}</p>
                              </div>
                              <div className="text-right">
                                <p className="text-[10px] text-outline font-label-sm uppercase">Selling</p>
                                <p className="font-label-sm text-primary text-sm font-black">Rs {parseFloat(fruit.selling_price).toFixed(2)}</p>
                              </div>
                            </div>

                            {/* Actions overlay */}
                            <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-outline-variant/30">
                              <button 
                                onClick={() => openEditFruit(fruit)}
                                className="p-1.5 text-on-surface-variant hover:bg-surface-container-high rounded transition-colors active:scale-90"
                              >
                                <span className="material-symbols-outlined text-[18px]">edit</span>
                              </button>
                              {user?.role === 'owner' && (
                                <button 
                                  onClick={() => handleDeleteFruit(fruit.id)}
                                  className="p-1.5 text-error hover:bg-error-container/20 rounded transition-colors active:scale-90"
                                >
                                  <span className="material-symbols-outlined text-[18px]">delete</span>
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ======================================================== */}
              {/* TAB 3: CUSTOMERS */}
              {/* ======================================================== */}
              {activeTab === 'customers' && (
                <div className="space-y-6 animate-fade-in no-print">
                  <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
                    <div>
                      <h2 className="font-headline-lg text-headline-lg text-on-surface">Customer Database</h2>
                      <p className="text-on-surface-variant mt-1">Manage credit accounts, ledgers, and transaction histories</p>
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="relative w-full md:w-64">
                        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline">search</span>
                        <input
                          type="text"
                          className="w-full pl-10 pr-4 py-2 bg-surface-container-low border border-outline-variant rounded-xl focus:outline-none focus:border-primary transition-colors text-sm font-semibold"
                          placeholder={t('searchCust')}
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                        />
                      </div>
                      <button 
                        onClick={() => {
                          setCustForm({ name: '', phone: '', address: '' });
                          setActiveModal('add-customer');
                        }}
                        className="px-4 py-2 bg-primary text-on-primary font-bold rounded-lg hover:opacity-90 active:scale-95 transition-all flex items-center gap-1.5 shadow-sm text-sm"
                      >
                        <span className="material-symbols-outlined text-[18px]">person_add</span>
                        <span>{t('addCustomer')}</span>
                      </button>
                    </div>
                  </div>

                  {/* Bento Customers List */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {customers.map(cust => {
                      const balanceVal = parseFloat(cust.balance_due);
                      const isCritical = balanceVal > 5000; 

                      return (
                        <div key={cust.id} className={`bg-surface-container-lowest border rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:shadow-md transition-shadow group ${
                          isCritical ? 'border-l-4 border-l-error border-outline-variant' : 'border-outline-variant'
                        }`}>
                          <div className="flex items-center gap-4">
                            <div className={`w-14 h-14 rounded-lg flex items-center justify-center ${
                              isCritical ? 'bg-error-container/30 text-error' : 'bg-surface-container-high text-primary-container'
                            }`}>
                              <span className="material-symbols-outlined text-[32px]">person</span>
                            </div>
                            <div>
                              <h3 className="text-body-lg font-bold text-on-surface">{cust.name}</h3>
                              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1">
                                <p className="text-body-md text-on-surface-variant flex items-center gap-1">
                                  <span className="material-symbols-outlined text-[16px]">call</span>
                                  {cust.phone}
                                </p>
                                <span className="w-1 h-1 rounded-full bg-outline-variant"></span>
                                <p className={`text-label-sm font-label-sm flex items-center gap-1 ${isCritical ? 'text-error' : 'text-primary'}`}>
                                  <span className={`w-2 h-2 rounded-full ${isCritical ? 'bg-error' : 'bg-primary'}`}></span>
                                  {isCritical ? 'Limit Exceeded' : 'Active'}
                                </p>
                              </div>
                            </div>
                          </div>

                          <div className="flex flex-col md:items-end justify-center md:border-l md:border-outline-variant md:pl-6 shrink-0">
                            <p className={`text-label-sm font-label-sm mb-1 uppercase ${isCritical ? 'text-error' : 'text-on-surface-variant'}`}>
                              {isCritical ? 'Overdue Balance' : 'Balance'}
                            </p>
                            <p className={`text-headline-md font-bold font-mono ${isCritical ? 'text-error' : 'text-on-surface'}`}>
                              Rs {balanceVal.toFixed(2)}
                            </p>
                            
                            <div className="flex items-center gap-3 mt-3">
                              <button 
                                onClick={() => openEditCustomer(cust)}
                                className="p-2 rounded-lg bg-surface-container-high text-on-surface-variant hover:bg-outline-variant transition-colors active:scale-95 duration-100 flex items-center"
                                title="Edit Customer Details"
                              >
                                <span className="material-symbols-outlined text-[18px]">edit</span>
                              </button>
                              
                              <button 
                                onClick={() => openLedger(cust)}
                                className="px-4 py-2 bg-primary text-on-primary text-xs font-bold rounded-lg hover:opacity-90 active:scale-95 transition-all"
                              >
                                View Ledger
                              </button>
                              
                              {balanceVal > 0 && (
                                <>
                                  <button 
                                    onClick={() => openRecordPayment(cust)}
                                    className="p-2 rounded-lg bg-primary-container text-on-primary-container hover:opacity-95 transition-colors active:scale-95 duration-100 flex items-center"
                                    title="Record Credit Payment"
                                  >
                                    <span className="material-symbols-outlined text-[18px]">payments</span>
                                  </button>
                                  <button 
                                    onClick={() => sendWhatsAppReminder(cust)}
                                    className="p-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors active:scale-95 duration-100 flex items-center"
                                    title="Send WhatsApp Dues Alert"
                                  >
                                    <span className="material-symbols-outlined text-[18px]">send</span>
                                  </button>
                                </>
                              )}
                              {user?.role === 'owner' && (
                                <button 
                                  onClick={() => handleDeleteCustomer(cust.id)}
                                  className="p-2 rounded-lg hover:bg-rose-50 text-rose-500 transition-colors active:scale-95 duration-100 flex items-center"
                                >
                                  <span className="material-symbols-outlined text-[18px]">delete</span>
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* ======================================================== */}
              {/* TAB 4: SALES ENTRY */}
              {/* ======================================================== */}
              {activeTab === 'sales-entry' && (
                <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-6 md:p-8 shadow-sm animate-fade-in no-print space-y-6">
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                    
                    {/* LHS Form inputs */}
                    <div className="lg:col-span-1 space-y-6">
                      <h3 className="text-lg font-bold text-on-surface border-b border-outline-variant pb-2">{t('newSale')}</h3>

                      <div>
                        <label className="block text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2">{t('selectCustomer')}</label>
                        <select 
                          className="w-full px-4 py-2.5 rounded-xl border border-outline bg-surface focus:ring-2 focus:ring-primary outline-none font-semibold text-sm"
                          value={selectedCustomerId}
                          onChange={(e) => setSelectedCustomerId(e.target.value)}
                        >
                          <option value="">-- Choose Account --</option>
                          {customers.map(c => (
                            <option key={c.id} value={c.id}>
                              {c.name} (Bal: Rs {parseFloat(c.balance_due).toFixed(2)})
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="p-4 bg-surface-container-low rounded-xl border border-outline-variant/50 space-y-4">
                        <p className="font-bold text-sm text-on-surface flex items-center gap-1.5">
                          <span className="material-symbols-outlined text-primary text-[18px]">shopping_bag</span>
                          <span>Cart Options</span>
                        </p>

                        <div>
                          <label className="block text-[10px] font-bold text-outline uppercase tracking-wider mb-1.5">{t('selectFruit')}</label>
                          <select 
                            className="w-full px-3 py-2.5 rounded-lg border border-outline bg-surface text-xs font-semibold"
                            value={currentSalesItem.fruit_id}
                            onChange={(e) => {
                              const fId = e.target.value;
                              const fruit = fruits.find(f => f.id === parseInt(fId));
                              setCurrentSalesItem({
                                ...currentSalesItem,
                                fruit_id: fId,
                                price: fruit ? fruit.selling_price : ''
                              });
                            }}
                          >
                            <option value="">-- Choose Fruit --</option>
                            {fruits.map(f => (
                              <option key={f.id} value={f.id} disabled={parseFloat(f.quantity_available) <= 0}>
                                {f.name} ({parseFloat(f.quantity_available).toFixed(1)} Kg stock)
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="block text-[10px] font-bold text-outline uppercase tracking-wider mb-1.5">{t('qty')} (Kg)</label>
                            <input 
                              type="number" 
                              step="any"
                              className="w-full px-3 py-2 border border-outline bg-surface rounded-lg text-xs font-bold"
                              placeholder="e.g. 50"
                              value={currentSalesItem.quantity}
                              onChange={(e) => setCurrentSalesItem({ ...currentSalesItem, quantity: e.target.value })}
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-bold text-outline uppercase tracking-wider mb-1.5">{t('price')} (Rs/Kg)</label>
                            <input 
                              type="number" 
                              step="any"
                              className="w-full px-3 py-2 border border-outline bg-surface rounded-lg text-xs font-bold"
                              placeholder="e.g. 100"
                              value={currentSalesItem.price}
                              onChange={(e) => setCurrentSalesItem({ ...currentSalesItem, price: e.target.value })}
                            />
                          </div>
                        </div>

                        <button
                          type="button"
                          onClick={handleAddSalesItem}
                          className="w-full py-2.5 bg-primary text-on-primary rounded-lg text-xs font-bold flex items-center justify-center gap-1.5 shadow-sm active:scale-95 transition-all"
                        >
                          <span className="material-symbols-outlined text-[16px]">add_shopping_cart</span>
                          <span>{t('addItem')}</span>
                        </button>
                      </div>
                    </div>

                    {/* Cart Items List */}
                    <div className="lg:col-span-2 space-y-6 flex flex-col justify-between">
                      <div className="space-y-4">
                        <h3 className="text-lg font-bold text-on-surface border-b border-outline-variant pb-2 flex justify-between items-center">
                          <span>Items Cart</span>
                          <span className="px-2.5 py-0.5 text-xs bg-surface-container-high text-on-surface rounded-full font-bold">{salesItems.length} categories</span>
                        </h3>

                        <div className="overflow-x-auto min-h-60 border border-outline-variant/70 rounded-xl bg-surface-container-lowest">
                          <table className="w-full text-left border-collapse text-xs">
                            <thead>
                              <tr className="bg-surface-container-low text-outline font-bold uppercase tracking-wider border-b border-outline-variant">
                                <th className="p-3">Fruit</th>
                                <th className="p-3 text-right">Quantity (Kg)</th>
                                <th className="p-3 text-right">Rate</th>
                                <th className="p-3 text-right">Total</th>
                                <th className="p-3 text-center">Action</th>
                              </tr>
                            </thead>
                            <tbody>
                              {salesItems.length === 0 ? (
                                <tr>
                                  <td colSpan="5" className="py-16 text-center text-outline font-semibold text-sm">
                                    Cart is empty. Add fruit items to generate billing invoice.
                                  </td>
                                </tr>
                              ) : (
                                salesItems.map((item, idx) => (
                                  <tr key={idx} className="border-b border-outline-variant/30 text-sm font-semibold hover:bg-surface-container-low/50">
                                    <td className="p-3 font-bold text-on-surface">{item.fruit_name}</td>
                                    <td className="p-3 text-right font-mono">{parseFloat(item.quantity).toFixed(2)}</td>
                                    <td className="p-3 text-right font-mono">Rs {parseFloat(item.price).toFixed(2)}</td>
                                    <td className="p-3 text-right font-mono text-primary font-black">Rs {parseFloat(item.total).toFixed(2)}</td>
                                    <td className="p-3 text-center">
                                      <button 
                                        onClick={() => handleRemoveSalesItem(idx)}
                                        className="p-1.5 text-error hover:bg-error-container/20 rounded-lg transition-all"
                                      >
                                        <span className="material-symbols-outlined text-[16px]">delete</span>
                                      </button>
                                    </td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      {/* Payment Settings */}
                      <div className="p-5 bg-surface-container rounded-2xl border border-outline-variant grid grid-cols-1 md:grid-cols-3 gap-6 items-end mt-4">
                        <div>
                          <label className="block text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2">{t('amountPaidUpfront')}</label>
                          <input 
                            type="number" 
                            className="w-full px-4 py-2.5 rounded-xl border border-outline bg-surface focus:ring-2 focus:ring-primary outline-none font-bold text-slate-800"
                            value={salesPaidAmount}
                            onChange={(e) => setSalesPaidAmount(e.target.value)}
                          />
                        </div>

                        <div>
                          <label className="block text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2">{t('dueDate')} (For outstanding dues)</label>
                          <input 
                            type="date" 
                            className="w-full px-4 py-2.5 rounded-xl border border-outline bg-surface focus:ring-2 focus:ring-primary outline-none font-semibold text-xs text-on-surface-variant"
                            value={salesDueDate}
                            onChange={(e) => setSalesDueDate(e.target.value)}
                          />
                        </div>

                        <div className="space-y-1 text-right">
                          <p className="text-[10px] font-bold text-outline uppercase tracking-wider">{t('totalBill')}</p>
                          <h2 className="text-2xl font-black text-on-surface font-mono">Rs {calculateSalesTotal().toFixed(2)}</h2>
                          {calculateSalesTotal() - parseFloat(salesPaidAmount || 0) > 0 && (
                            <p className="text-xs text-error font-bold font-mono">{t('remainingDues')}: Rs {(calculateSalesTotal() - parseFloat(salesPaidAmount || 0)).toFixed(2)}</p>
                          )}
                        </div>
                      </div>

                      <div className="mt-6 flex justify-end gap-3">
                        <input 
                          type="text" 
                          placeholder="Transaction description / notes..."
                          className="flex-1 px-4 py-3 rounded-xl border border-outline bg-surface text-sm focus:outline-none focus:border-primary font-semibold"
                          value={salesNotes}
                          onChange={(e) => setSalesNotes(e.target.value)}
                        />
                        <button 
                          onClick={handleSaveSale}
                          className="px-6 py-3 bg-primary text-on-primary rounded-xl font-bold text-sm shadow-md hover:opacity-90 active:scale-95 transition-all flex items-center gap-2"
                        >
                          <span className="material-symbols-outlined text-[18px]">receipt</span>
                          <span>{t('saveSale')}</span>
                        </button>
                      </div>

                    </div>

                  </div>
                </div>
              )}

              {/* ======================================================== */}
              {/* TAB 5: DAILY CASH BOOK */}
              {/* ======================================================== */}
              {activeTab === 'cashbook' && (
                <div className="space-y-6 animate-fade-in no-print">
                  <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4 bg-white p-5 rounded-xl border border-outline-variant shadow-sm">
                    <div>
                      <h3 className="text-lg font-bold text-on-surface">{t('dailyCashBook')}</h3>
                      <p className="text-xs text-on-surface-variant mt-0.5">Track daily cash receipts, expenses, and closing bounds</p>
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="relative">
                        <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-outline text-[16px]">calendar_month</span>
                        <input
                          type="date"
                          className="pl-9 pr-4 py-2 border border-outline bg-surface rounded-xl outline-none font-semibold text-xs text-on-surface-variant"
                          value={cashbookDate}
                          onChange={(e) => setCashbookDate(e.target.value)}
                        />
                      </div>
                      
                      <button 
                        onClick={() => {
                          setCashForm({ type: 'cash_out', amount: '', category: 'expense', description: '' });
                          setActiveModal('add-cash');
                        }}
                        className="px-4 py-2 bg-secondary text-on-secondary font-bold rounded-lg hover:opacity-90 active:scale-95 transition-all text-xs flex items-center gap-1.5 shadow-sm"
                      >
                        <span className="material-symbols-outlined text-[16px]">add</span>
                        <span>{t('addCashEntry')}</span>
                      </button>
                    </div>
                  </div>

                  {/* Cashbook Balances Summary */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="bg-surface-container-lowest border border-outline-variant p-5 rounded-xl shadow-sm">
                      <span className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">{t('openingBalance')}</span>
                      <h4 className="text-xl font-black text-on-surface font-mono mt-1">Rs {cashbookData.openingBalance.toFixed(2)}</h4>
                    </div>
                    <div className="bg-surface-container-lowest border border-outline-variant p-5 rounded-xl shadow-sm grid grid-cols-2 gap-4">
                      <div>
                        <span className="text-[10px] font-bold text-primary uppercase tracking-wider">{t('cashInflow')}</span>
                        <h4 className="text-lg font-black text-primary font-mono mt-1">+ {cashbookData.dailyIn.toFixed(2)}</h4>
                      </div>
                      <div>
                        <span className="text-[10px] font-bold text-error uppercase tracking-wider">{t('cashOutflow')}</span>
                        <h4 className="text-lg font-black text-error font-mono mt-1">- {cashbookData.dailyOut.toFixed(2)}</h4>
                      </div>
                    </div>
                    <div className="bg-primary-container text-on-primary-container border border-primary/20 p-5 rounded-xl shadow-sm">
                      <span className="text-[10px] font-bold uppercase tracking-wider opacity-80">{t('closingBalance')}</span>
                      <h4 className="text-2xl font-black font-mono mt-1">Rs {cashbookData.closingBalance.toFixed(2)}</h4>
                    </div>
                  </div>

                  {/* Daily list */}
                  <div className="bg-surface-container-lowest rounded-xl border border-outline-variant shadow-sm overflow-hidden">
                    <div className="p-5 border-b border-outline-variant font-bold text-on-surface text-sm">
                      Transactions for {new Date(cashbookDate).toLocaleDateString()}
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-surface-container-low text-outline font-bold uppercase tracking-wider border-b border-outline-variant">
                            <th className="p-4 pl-6">Type</th>
                            <th className="p-4">Category</th>
                            <th className="p-4">Description</th>
                            <th className="p-4 text-right">Amount (Rs)</th>
                            <th className="p-4 text-center">Recorded By</th>
                          </tr>
                        </thead>
                        <tbody>
                          {cashbookData.entries.length === 0 ? (
                            <tr>
                              <td colSpan="5" className="py-16 text-center text-outline font-semibold text-sm">
                                No transactions logged in the cash book for this date.
                              </td>
                            </tr>
                          ) : (
                            cashbookData.entries.map(entry => (
                              <tr key={entry.id} className="border-b border-outline-variant/30 text-sm font-semibold hover:bg-surface-container-low/50">
                                <td className="p-4 pl-6">
                                  {entry.type === 'cash_in' ? (
                                    <span className="flex items-center gap-1.5 text-primary">
                                      <span className="material-symbols-outlined text-[18px]">trending_up</span>
                                      <span>{t('cashIn')}</span>
                                    </span>
                                  ) : (
                                    <span className="flex items-center gap-1.5 text-error">
                                      <span className="material-symbols-outlined text-[18px]">trending_down</span>
                                      <span>{t('cashOut')}</span>
                                    </span>
                                  )}
                                </td>
                                <td className="p-4">
                                  <span className="px-2.5 py-0.5 bg-surface-container border border-outline-variant rounded font-bold text-xs capitalize">
                                    {t(entry.category) || entry.category}
                                  </span>
                                </td>
                                <td className="p-4 text-on-surface-variant font-medium max-w-xs truncate">{entry.description || '-'}</td>
                                <td className={`p-4 text-right font-extrabold font-mono ${entry.type === 'cash_in' ? 'text-primary' : 'text-error'}`}>
                                  {entry.type === 'cash_in' ? '+' : '-'} Rs {parseFloat(entry.amount).toFixed(2)}
                                </td>
                                <td className="p-4 text-center text-outline text-xs">{entry.user_name || 'System'}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}

              {/* ======================================================== */}
              {/* TAB 6: REPORTS */}
              {/* ======================================================== */}
              {activeTab === 'reports' && (
                <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-6 md:p-8 shadow-sm animate-fade-in no-print space-y-6">
                  <div>
                    <h3 className="text-lg font-bold text-on-surface">{t('generateReports')}</h3>
                    <p className="text-xs text-on-surface-variant mt-0.5">Filter, analyze profit ledger states, and export documents</p>
                  </div>

                  {/* Filters Bar */}
                  <div className="p-5 bg-surface-container-low rounded-xl border border-outline-variant grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
                    <div>
                      <label className="block text-[10px] font-bold text-outline uppercase tracking-wider mb-2">{t('reportType')}</label>
                      <select 
                        className="w-full px-3 py-2 border border-outline bg-surface rounded-xl outline-none font-bold text-sm"
                        value={reportType}
                        onChange={(e) => setReportType(e.target.value)}
                      >
                        <option value="daily">{t('dailyReport')}</option>
                        <option value="weekly">{t('weeklyReport')}</option>
                        <option value="monthly">{t('monthlyReport')}</option>
                        <option value="profit">{t('profitReport')}</option>
                        <option value="outstanding">{t('outstandingReport')}</option>
                      </select>
                    </div>

                    {reportType !== 'outstanding' && (
                      <>
                        <div>
                          <label className="block text-[10px] font-bold text-outline uppercase tracking-wider mb-2">From Date</label>
                          <input 
                            type="date"
                            className="w-full px-3 py-2 border border-outline bg-surface rounded-xl outline-none font-semibold text-sm text-on-surface"
                            value={reportStartDate}
                            onChange={(e) => setReportStartDate(e.target.value)}
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-bold text-outline uppercase tracking-wider mb-2">To Date</label>
                          <input 
                            type="date"
                            className="w-full px-3 py-2 border border-outline bg-surface rounded-xl outline-none font-semibold text-sm text-on-surface"
                            value={reportEndDate}
                            onChange={(e) => setReportEndDate(e.target.value)}
                          />
                        </div>
                      </>
                    )}

                    <div className="flex gap-2">
                      <button 
                        onClick={handleGenerateReport}
                        className="flex-1 py-2.5 bg-primary text-on-primary font-bold rounded-xl text-xs transition-all shadow-sm active:scale-95"
                      >
                        Run Report
                      </button>
                      {reportResult && (
                        <>
                          <button 
                            onClick={handleExportExcel}
                            className="py-2.5 px-3 bg-secondary text-on-secondary font-bold rounded-xl text-xs transition-all shadow-sm"
                            title="Download Excel Spreadsheet"
                          >
                            Excel
                          </button>
                          <button 
                            onClick={handleExportPdfReport}
                            className="py-2.5 px-3 bg-surface-container-highest text-on-surface-variant font-bold border border-outline-variant rounded-xl text-xs transition-all"
                            title="Print PDF File"
                          >
                            Print
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Result Table */}
                  {reportResult && (
                    <div className="space-y-6 pt-4 border-t border-outline-variant/40">
                      
                      {/* Summary Cards */}
                      {reportResult.summary && (
                        <div className="p-5 bg-surface-container-low rounded-xl border border-outline-variant flex flex-wrap gap-8 justify-around">
                          {reportResult.reportType === 'profit' ? (
                            <>
                              <div className="text-center">
                                <span className="text-[10px] font-bold text-outline uppercase">{t('totalRevenue')}</span>
                                <h4 className="text-lg font-black text-on-surface font-mono mt-1">Rs {reportResult.summary.totalRevenue.toFixed(2)}</h4>
                              </div>
                              <div className="text-center">
                                <span className="text-[10px] font-bold text-outline uppercase">{t('totalCost')}</span>
                                <h4 className="text-lg font-black text-on-surface-variant font-mono mt-1">Rs {reportResult.summary.totalCost.toFixed(2)}</h4>
                              </div>
                              <div className="text-center">
                                <span className="text-[10px] font-bold text-primary uppercase">{t('netProfit')}</span>
                                <h4 className="text-xl font-black text-primary font-mono mt-1">Rs {reportResult.summary.totalProfit.toFixed(2)}</h4>
                              </div>
                            </>
                          ) : (
                            <>
                              <div className="text-center">
                                <span className="text-[10px] font-bold text-outline uppercase">Total Invoiced</span>
                                <h4 className="text-lg font-black text-on-surface font-mono mt-1">Rs {reportResult.summary.totalAmount.toFixed(2)}</h4>
                              </div>
                              <div className="text-center">
                                <span className="text-[10px] font-bold text-outline uppercase">Collected upfront</span>
                                <h4 className="text-lg font-black text-primary font-mono mt-1">Rs {reportResult.summary.totalPaid.toFixed(2)}</h4>
                              </div>
                              <div className="text-center">
                                <span className="text-[10px] font-bold text-error uppercase">Outstanding Created</span>
                                <h4 className="text-lg font-black text-error font-mono mt-1">Rs {reportResult.summary.totalDues.toFixed(2)}</h4>
                              </div>
                            </>
                          )}
                        </div>
                      )}

                      {/* Details list table */}
                      <div className="overflow-x-auto border border-outline-variant rounded-xl bg-surface-container-lowest">
                        <table className="w-full text-left border-collapse text-xs">
                          {reportResult.reportType === 'outstanding' && (
                            <>
                              <thead>
                                <tr className="bg-surface-container-low text-outline font-bold uppercase tracking-wider border-b border-outline-variant">
                                  <th className="p-4 pl-6">Customer</th>
                                  <th className="p-4">Phone</th>
                                  <th className="p-4">Address</th>
                                  <th className="p-4 text-right">Outstanding (Rs)</th>
                                  <th className="p-4 text-center">Remind</th>
                                </tr>
                              </thead>
                              <tbody>
                                {reportResult.data.length === 0 ? (
                                  <tr>
                                    <td colSpan="5" className="py-16 text-center text-outline font-semibold text-sm">No customers have outstanding credit.</td>
                                  </tr>
                                ) : (
                                  reportResult.data.map(cust => (
                                    <tr key={cust.id} className="border-b border-outline-variant/30 text-sm font-semibold hover:bg-surface-container-low/50">
                                      <td className="p-4 pl-6 font-bold text-on-surface">{cust.name}</td>
                                      <td className="p-4 text-on-surface-variant font-mono">{cust.phone}</td>
                                      <td className="p-4 text-on-surface-variant truncate max-w-xs">{cust.address || '-'}</td>
                                      <td className="p-4 text-right text-error font-extrabold font-mono">Rs {parseFloat(cust.balance_due).toFixed(2)}</td>
                                      <td className="p-4 text-center">
                                        <button 
                                          onClick={() => sendWhatsAppReminder(cust)}
                                          className="px-2.5 py-1 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 rounded-lg text-xs font-bold transition-all border border-emerald-100"
                                        >
                                          {t('whatsappReminder')}
                                        </button>
                                      </td>
                                    </tr>
                                  ))
                                )}
                              </tbody>
                            </>
                          )}

                          {reportResult.reportType === 'profit' && (
                            <>
                              <thead>
                                <tr className="bg-surface-container-low text-outline font-bold uppercase tracking-wider border-b border-outline-variant">
                                  <th className="p-4 pl-6">Date</th>
                                  <th className="p-4">Customer</th>
                                  <th className="p-4">Fruit</th>
                                  <th className="p-4 text-right">Qty</th>
                                  <th className="p-4 text-right">Sale Price</th>
                                  <th className="p-4 text-right">Cost Price</th>
                                  <th className="p-4 text-right">Net Profit</th>
                                </tr>
                              </thead>
                              <tbody>
                                {reportResult.data.length === 0 ? (
                                  <tr>
                                    <td colSpan="7" className="py-16 text-center text-outline font-semibold text-sm">No profit logs compiled.</td>
                                  </tr>
                                ) : (
                                  reportResult.data.map((row, idx) => (
                                    <tr key={idx} className="border-b border-outline-variant/30 text-sm font-semibold hover:bg-surface-container-low/50">
                                      <td className="p-4 pl-6 text-outline font-mono">{new Date(row.sale_date).toLocaleDateString()}</td>
                                      <td className="p-4 text-on-surface">{row.customer_name}</td>
                                      <td className="p-4 text-on-surface-variant">{row.fruit_name}</td>
                                      <td className="p-4 text-right font-mono">{parseFloat(row.quantity).toFixed(1)} Kg</td>
                                      <td className="p-4 text-right font-mono">Rs {parseFloat(row.sale_price).toFixed(2)}</td>
                                      <td className="p-4 text-right font-mono text-outline">Rs {parseFloat(row.cost_price).toFixed(2)}</td>
                                      <td className="p-4 text-right font-mono text-primary font-black">+ Rs {parseFloat(row.profit_amount).toFixed(2)}</td>
                                    </tr>
                                  ))
                                )}
                              </tbody>
                            </>
                          )}

                          {(reportResult.reportType !== 'outstanding' && reportResult.reportType !== 'profit') && (
                            <>
                              <thead>
                                <tr className="bg-surface-container-low text-outline font-bold uppercase tracking-wider border-b border-outline-variant">
                                  <th className="p-4 pl-6">Invoice</th>
                                  <th className="p-4">Customer</th>
                                  <th className="p-4">Date</th>
                                  <th className="p-4 text-right">Bill Total</th>
                                  <th className="p-4 text-right">Paid upfront</th>
                                  <th className="p-4 text-right">Remaining Balance</th>
                                  <th className="p-4 text-center">Status</th>
                                </tr>
                              </thead>
                              <tbody>
                                {reportResult.data.length === 0 ? (
                                  <tr>
                                    <td colSpan="7" className="py-16 text-center text-outline font-semibold text-sm">No sales records logged.</td>
                                  </tr>
                                ) : (
                                  reportResult.data.map(sale => (
                                    <tr key={sale.id} className="border-b border-outline-variant/30 text-sm font-semibold hover:bg-surface-container-low/50">
                                      <td className="p-4 pl-6 font-bold text-primary">#{sale.id}</td>
                                      <td className="p-4 text-on-surface font-bold">{sale.customer_name}</td>
                                      <td className="p-4 text-outline font-mono">{new Date(sale.sale_date).toLocaleDateString()}</td>
                                      <td className="p-4 text-right font-bold font-mono">Rs {parseFloat(sale.total_amount).toFixed(2)}</td>
                                      <td className="p-4 text-right text-primary font-mono">Rs {parseFloat(sale.paid_amount).toFixed(2)}</td>
                                      <td className="p-4 text-right text-error font-mono font-bold">Rs {parseFloat(sale.balance_due).toFixed(2)}</td>
                                      <td className="p-4 text-center">
                                        <span className={`px-2.5 py-0.5 rounded-full font-bold text-[10px] uppercase ${
                                          sale.status === 'paid' ? 'bg-primary-container/20 text-primary' :
                                          sale.status === 'partially_paid' ? 'bg-secondary-container/20 text-secondary' : 'bg-error-container/20 text-error'
                                        }`}>
                                          {sale.status}
                                        </span>
                                      </td>
                                    </tr>
                                  ))
                                )}
                              </tbody>
                            </>
                          )}

                        </table>
                      </div>

                    </div>
                  )}

                </div>
              )}

              {/* ======================================================== */}
              {/* TAB 7: BACKUP & USER MANAGEMENT (Owners only) */}
              {/* ======================================================== */}
              {activeTab === 'backup' && user?.role === 'owner' && (
                <div className="space-y-6 animate-fade-in no-print">
                  {/* Sub-tab navigation */}
                  <div className="flex border-b border-outline-variant gap-4">
                    <button 
                      onClick={() => setAdminSubTab('db')}
                      className={`pb-2 text-sm font-bold transition-colors ${adminSubTab === 'db' ? 'border-b-2 border-primary text-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
                    >
                      Database Dumps
                    </button>
                    <button 
                      onClick={() => setAdminSubTab('users')}
                      className={`pb-2 text-sm font-bold transition-colors ${adminSubTab === 'users' ? 'border-b-2 border-primary text-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
                    >
                      Google Users Registry
                    </button>
                  </div>

                  {/* Admin sub-tab 1: Database Operations */}
                  {adminSubTab === 'db' && (
                    <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-6 md:p-8 shadow-sm space-y-8 animate-fade-in">
                      <div>
                        <h3 className="text-lg font-bold text-on-surface">{t('dbManagement')}</h3>
                        <p className="text-xs text-on-surface-variant mt-0.5">JSON exports and ledger restores</p>
                      </div>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                        <div className="p-6 bg-surface-container-low rounded-xl border border-outline-variant/70 space-y-4">
                          <h4 className="font-bold text-on-surface text-sm flex items-center gap-1.5">
                            <span className="material-symbols-outlined text-primary">backup</span>
                            <span>{t('exportBackup')}</span>
                          </h4>
                          <p className="text-xs text-on-surface-variant">
                            Saves all transaction lists, credit distribution ledgers, client directory, and fruit stocks into a single offline file.
                          </p>
                          <button
                            onClick={handleBackupExport}
                            className="py-3 px-5 bg-primary text-on-primary rounded-xl font-bold text-xs shadow-md hover:opacity-90 active:scale-95 transition-all flex items-center gap-2"
                          >
                            <span className="material-symbols-outlined text-[16px]">download</span>
                            <span>Download JSON</span>
                          </button>
                        </div>

                        <div className="p-6 bg-error-container/10 rounded-xl border border-error/20 space-y-4">
                          <h4 className="font-bold text-error text-sm flex items-center gap-1.5">
                            <span className="material-symbols-outlined text-error">settings_backup_restore</span>
                            <span>{t('restoreBackup')}</span>
                          </h4>
                          <p className="text-xs text-error font-semibold bg-error-container/20 p-3.5 rounded-xl border border-error/10">
                            ⚠️ Warning: All current transaction logs and ledger bounds will be permanently overwritten.
                          </p>

                          <form onSubmit={handleBackupRestore} className="space-y-4">
                            <div>
                              <label className="block text-[10px] font-bold text-outline uppercase tracking-wider mb-2">{t('selectBackupFile')}</label>
                              <input 
                                type="file" 
                                accept=".json"
                                onChange={(e) => setBackupFile(e.target.files[0])}
                                className="w-full text-xs text-outline file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-bold file:bg-surface-container-high file:text-on-surface-variant hover:file:opacity-90 file:cursor-pointer"
                              />
                            </div>
                            <button
                              type="submit"
                              disabled={!backupFile}
                              className={`py-3 px-5 text-white rounded-xl font-bold text-xs shadow-md transition-all flex items-center gap-2 ${
                                backupFile ? 'bg-error hover:opacity-90' : 'bg-slate-300 cursor-not-allowed shadow-none'
                              }`}
                            >
                              <span className="material-symbols-outlined text-[16px]">cloud_upload</span>
                              <span>Upload & Restore</span>
                            </button>
                          </form>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Admin sub-tab 2: User Role-Based Access List */}
                  {adminSubTab === 'users' && (
                    <div className="grid grid-cols-1 xl:grid-cols-3 gap-8 animate-fade-in">
                      {/* Left side: add email register form */}
                      <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-6 shadow-sm xl:col-span-1 space-y-4">
                        <h4 className="font-bold text-on-surface text-sm border-b border-outline-variant pb-2">Pre-Register Google Email</h4>
                        <form onSubmit={handleAddUser} className="space-y-4">
                          <div>
                            <label className="block text-[10px] font-bold text-outline uppercase mb-1.5">Google Account Email</label>
                            <input 
                              type="email" 
                              required
                              className="w-full px-3 py-2 border border-outline bg-surface rounded-xl text-xs font-semibold"
                              placeholder="e.g. operator@gmail.com"
                              value={userForm.email}
                              onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-bold text-outline uppercase mb-1.5">Full Name</label>
                            <input 
                              type="text" 
                              required
                              className="w-full px-3 py-2 border border-outline bg-surface rounded-xl text-xs font-semibold"
                              placeholder="e.g. Ramesh Kumar"
                              value={userForm.name}
                              onChange={(e) => setUserForm({ ...userForm, name: e.target.value })}
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-bold text-outline uppercase mb-1.5">System Permission Role</label>
                            <select 
                              className="w-full px-3 py-2 border border-outline bg-surface rounded-xl text-xs font-semibold"
                              value={userForm.role}
                              onChange={(e) => setUserForm({ ...userForm, role: e.target.value })}
                            >
                              <option value="staff">Staff Operator</option>
                              <option value="admin">System Administrator</option>
                            </select>
                          </div>
                          <button
                            type="submit"
                            className="w-full py-2.5 bg-primary text-on-primary rounded-xl text-xs font-bold shadow-sm"
                          >
                            Register User Permission
                          </button>
                        </form>
                      </div>

                      {/* Right side: user registry list */}
                      <div className="bg-surface-container-lowest border border-outline-variant rounded-xl p-6 shadow-sm xl:col-span-2 flex flex-col">
                        <h4 className="font-bold text-on-surface text-sm border-b border-outline-variant pb-2 mb-4">Active Google Sign-In Permissions</h4>
                        <div className="overflow-x-auto">
                          <table className="w-full text-left border-collapse text-xs">
                            <thead>
                              <tr className="border-b border-outline-variant text-outline font-bold uppercase">
                                <th className="py-2.5 px-2">Name / Email</th>
                                <th className="py-2.5 px-2">Access Role</th>
                                <th className="py-2.5 px-2 text-center">Status</th>
                                <th className="py-2.5 px-2 text-center">Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {systemUsers.map(u => (
                                <tr key={u.id} className="border-b border-outline-variant/30 hover:bg-surface-container-low/50 text-sm">
                                  <td className="py-3 px-2">
                                    <div>
                                      <p className="font-bold text-on-surface">{u.name}</p>
                                      <p className="text-[10px] text-outline font-mono font-medium">{u.email}</p>
                                    </div>
                                  </td>
                                  <td className="py-3 px-2">
                                    <select
                                      className="px-2 py-1 text-xs border border-outline rounded bg-surface font-semibold"
                                      value={u.role}
                                      disabled={u.email === user.email} // Protect demoting oneself
                                      onChange={(e) => handleUpdateUserRole(u, e.target.value)}
                                    >
                                      <option value="staff">Staff</option>
                                      <option value="admin">Admin</option>
                                    </select>
                                  </td>
                                  <td className="py-3 px-2 text-center">
                                    <button
                                      onClick={() => handleToggleUserStatus(u)}
                                      disabled={u.email === user.email} // Protect deactivating oneself
                                      className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase transition-all ${
                                        u.status === 'active' 
                                          ? 'bg-primary-container/20 text-primary border border-primary/20' 
                                          : 'bg-slate-100 text-slate-500 border border-slate-200'
                                      }`}
                                    >
                                      {u.status}
                                    </button>
                                  </td>
                                  <td className="py-3 px-2 text-center">
                                    <button 
                                      onClick={() => handleDeleteUser(u.id)}
                                      disabled={u.email === user.email} // Protect deleting oneself
                                      className={`p-1.5 text-error rounded-lg ${u.email === user.email ? 'opacity-30 cursor-not-allowed' : 'hover:bg-error-container/20'}`}
                                    >
                                      <span className="material-symbols-outlined text-[16px]">delete</span>
                                    </button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

            </main>
          </div>

          {/* Floating Action Button (FAB) for Quick Sales Entry */}
          <button 
            onClick={() => { setActiveTab('sales-entry'); setSearchQuery(''); }}
            className="no-print fixed bottom-24 right-6 md:bottom-8 md:right-8 bg-primary-container text-on-primary-container w-14 h-14 rounded-full shadow-lg flex items-center justify-center hover:scale-110 active:scale-90 transition-transform z-40 group"
            title="Create New Billing Invoice"
          >
            <span className="material-symbols-outlined text-[32px] transition-transform group-hover:rotate-90">add</span>
          </button>

          {/* Mobile Bottom Navigation Bar */}
          <nav className="no-print md:hidden fixed bottom-0 left-0 w-full flex justify-around items-center px-2 py-3 bg-surface border-t border-outline-variant z-40 shadow-lg shrink-0">
            {[
              { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
              { id: 'inventory', label: 'Inventory', icon: 'inventory_2' },
              { id: 'customers', label: 'Customers', icon: 'group' },
              { id: 'sales-entry', label: 'Sales', icon: 'receipt_long' },
              ...(user?.role === 'owner' ? [{ id: 'cashbook', label: 'CashBook', icon: 'book' }] : [])
            ].map(tab => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => { setActiveTab(tab.id); setSearchQuery(''); }}
                  className={`flex flex-col items-center justify-center p-2 rounded-xl transition-all ${
                    isActive 
                      ? 'bg-primary-container text-on-primary-container font-bold px-4 py-1' 
                      : 'text-on-surface-variant'
                  }`}
                >
                  <span className="material-symbols-outlined">{tab.icon}</span>
                  <span className="text-[10px] mt-0.5 font-medium">{tab.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Footer - Hidden in Print */}
          <footer className="no-print bg-surface border-t border-outline-variant py-4 text-center text-[10px] font-bold text-outline uppercase tracking-wider shrink-0">
            {t('businessName')} © 2026 - BUSSINESS CLUB Platform v2.4.0
          </footer>

          {/* ======================================================== */}
          {/* PRINT SCREEN AREA - Active ONLY during window.print() */}
          {/* ======================================================== */}
          {activeTab === 'reports' && reportResult && (
            <div className="hidden print:block w-full text-left p-6 print-area font-sans">
              <h2 className="text-2xl font-bold text-slate-800 uppercase tracking-tight">{t('businessName')} REPORT</h2>
              <p className="text-xs text-slate-500 mt-1 font-semibold">Platform: BUSSINESS CLUB v2.4.0 | Date: {new Date().toLocaleString()}</p>
              <p className="text-xs text-slate-500">Report bounds: {reportType.toUpperCase()} ({reportStartDate} to {reportEndDate})</p>
              
              <div className="mt-6 border-b-2 border-slate-800 pb-3">
                {reportResult.summary && (
                  <div className="flex gap-10 font-bold text-xs uppercase">
                    {reportResult.reportType === 'profit' ? (
                      <>
                        <span>Revenue: Rs {reportResult.summary.totalRevenue.toFixed(2)}</span>
                        <span>Cost: Rs {reportResult.summary.totalCost.toFixed(2)}</span>
                        <span>Net Profit: Rs {reportResult.summary.totalProfit.toFixed(2)}</span>
                      </>
                    ) : (
                      <>
                        <span>Sales total: Rs {reportResult.summary.totalAmount.toFixed(2)}</span>
                        <span>Paid upfront: Rs {reportResult.summary.totalPaid.toFixed(2)}</span>
                        <span>outstanding dues: Rs {reportResult.summary.totalDues.toFixed(2)}</span>
                      </>
                    )}
                  </div>
                )}
              </div>

              <table className="w-full text-left mt-6 border-collapse text-[10px] font-semibold">
                <thead>
                  <tr className="border-b-2 border-slate-400 font-bold uppercase text-[9px] text-slate-500">
                    {reportResult.reportType === 'outstanding' && (
                      <>
                        <th className="py-2 pl-4">Customer</th>
                        <th className="py-2">Phone</th>
                        <th className="py-2">Address</th>
                        <th className="py-2 text-right">Outstanding balance (Rs)</th>
                      </>
                    )}
                    {reportResult.reportType === 'profit' && (
                      <>
                        <th className="py-2 pl-4">Date</th>
                        <th className="py-2">Customer</th>
                        <th className="py-2">Fruit</th>
                        <th className="py-2 text-right">Qty</th>
                        <th className="py-2 text-right">Rate</th>
                        <th className="py-2 text-right">Cost</th>
                        <th className="py-2 text-right">Profit</th>
                      </>
                    )}
                    {(reportResult.reportType !== 'outstanding' && reportResult.reportType !== 'profit') && (
                      <>
                        <th className="py-2 pl-4">ID</th>
                        <th className="py-2">Customer</th>
                        <th className="py-2">Date</th>
                        <th className="py-2 text-right">Bill Amt</th>
                        <th className="py-2 text-right">Paid</th>
                        <th className="py-2 text-right">Due Dues</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {reportResult.data.map((row, idx) => (
                    <tr key={idx} className="border-b border-slate-200 text-slate-700">
                      {reportResult.reportType === 'outstanding' && (
                        <>
                          <td className="py-2 pl-4 font-bold">{row.name}</td>
                          <td className="py-2">{row.phone}</td>
                          <td className="py-2">{row.address || '-'}</td>
                          <td className="py-2 text-right font-mono">Rs {parseFloat(row.balance_due).toFixed(2)}</td>
                        </>
                      )}
                      {reportResult.reportType === 'profit' && (
                        <>
                          <td className="py-2 pl-4 font-mono">{new Date(row.sale_date).toLocaleDateString()}</td>
                          <td className="py-2">{row.customer_name}</td>
                          <td className="py-2">{row.fruit_name}</td>
                          <td className="py-2 text-right font-mono">{parseFloat(row.quantity).toFixed(1)} Kg</td>
                          <td className="py-2 text-right font-mono">Rs {parseFloat(row.sale_price).toFixed(2)}</td>
                          <td className="py-2 text-right font-mono">Rs {parseFloat(row.cost_price).toFixed(2)}</td>
                          <td className="py-2 text-right font-mono font-bold text-slate-900">Rs {parseFloat(row.profit_amount).toFixed(2)}</td>
                        </>
                      )}
                      {(reportResult.reportType !== 'outstanding' && reportResult.reportType !== 'profit') && (
                        <>
                          <td className="py-2 pl-4 font-bold">#{row.id}</td>
                          <td className="py-2 font-bold">{row.customer_name}</td>
                          <td className="py-2 font-mono">{new Date(row.sale_date).toLocaleDateString()}</td>
                          <td className="py-2 text-right font-mono">Rs {parseFloat(row.total_amount).toFixed(2)}</td>
                          <td className="py-2 text-right font-mono">Rs {parseFloat(row.paid_amount).toFixed(2)}</td>
                          <td className="py-2 text-right font-mono">Rs {parseFloat(row.balance_due).toFixed(2)}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ======================================================== */}
          {/* SYSTEM MODALS */}
          {/* ======================================================== */}
          {activeModal && (
            <div className="no-print fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
              <div className="bg-surface-container-lowest rounded-3xl shadow-2xl p-6 md:p-8 max-w-lg w-full max-h-[85vh] overflow-y-auto animate-fade-in relative border border-outline-variant/30">
                
                {/* Add / Edit Customer */}
                {(activeModal === 'add-customer' || activeModal === 'edit-customer') && (
                  <div>
                    <h3 className="text-xl font-bold text-on-surface mb-6">{activeModal === 'add-customer' ? t('addCustomer') : t('editCustomer')}</h3>
                    <form onSubmit={handleSaveCustomer} className="space-y-4">
                      <div>
                        <label className="block text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2">{t('custName')}</label>
                        <input 
                          type="text" 
                          className="w-full px-4 py-2.5 rounded-xl border border-outline bg-surface focus:ring-2 focus:ring-primary outline-none font-semibold text-sm"
                          value={custForm.name}
                          onChange={(e) => setCustForm({ ...custForm, name: e.target.value })}
                          required
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2">{t('phone')}</label>
                        <input 
                          type="text" 
                          className="w-full px-4 py-2.5 rounded-xl border border-outline bg-surface focus:ring-2 focus:ring-primary outline-none font-semibold text-sm"
                          placeholder="+1 (555) 000-0000"
                          value={custForm.phone}
                          onChange={(e) => setCustForm({ ...custForm, phone: e.target.value })}
                          required
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2">{t('address')}</label>
                        <textarea 
                          className="w-full px-4 py-2.5 rounded-xl border border-outline bg-surface focus:ring-2 focus:ring-primary outline-none font-semibold text-sm h-20 resize-none"
                          value={custForm.address}
                          onChange={(e) => setCustForm({ ...custForm, address: e.target.value })}
                        />
                      </div>

                      <div className="flex justify-end gap-3 pt-4 border-t border-outline-variant/30">
                        <button 
                          type="button" 
                          onClick={() => setActiveModal(null)}
                          className="px-4 py-2.5 text-outline hover:bg-surface-container-high font-bold rounded-xl text-xs"
                        >
                          {t('cancel')}
                        </button>
                        <button 
                          type="submit"
                          className="px-5 py-2.5 bg-primary text-on-primary font-bold rounded-xl text-xs"
                        >
                          {t('save')}
                        </button>
                      </div>
                    </form>
                  </div>
                )}

                {/* Add / Edit Fruit */}
                {(activeModal === 'add-fruit' || activeModal === 'edit-fruit') && (
                  <div>
                    <h3 className="text-xl font-bold text-on-surface mb-6">{activeModal === 'add-fruit' ? t('addFruit') : t('editFruit')}</h3>
                    <form onSubmit={handleSaveFruit} className="space-y-4">
                      <div>
                        <label className="block text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2">{t('fruitName')}</label>
                        <input 
                          type="text" 
                          className="w-full px-4 py-2.5 rounded-xl border border-outline bg-surface focus:ring-2 focus:ring-primary outline-none font-semibold text-sm"
                          placeholder="e.g. Alphonso Mango"
                          value={fruitForm.name}
                          onChange={(e) => setFruitForm({ ...fruitForm, name: e.target.value })}
                          required
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2">{t('qtyAvailable')}</label>
                          <input 
                            type="number" 
                            step="any"
                            className="w-full px-4 py-2.5 rounded-xl border border-outline bg-surface focus:ring-2 focus:ring-primary outline-none font-semibold text-sm"
                            value={fruitForm.quantity_available}
                            onChange={(e) => setFruitForm({ ...fruitForm, quantity_available: e.target.value })}
                            required
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2">{t('minStock')}</label>
                          <input 
                            type="number" 
                            step="any"
                            className="w-full px-4 py-2.5 rounded-xl border border-outline bg-surface focus:ring-2 focus:ring-primary outline-none font-semibold text-sm"
                            value={fruitForm.min_stock_alert}
                            onChange={(e) => setFruitForm({ ...fruitForm, min_stock_alert: e.target.value })}
                            required
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2">{t('purchasePrice')} (Rs/Kg)</label>
                          <input 
                            type="number" 
                            step="any"
                            className="w-full px-4 py-2.5 rounded-xl border border-outline bg-surface focus:ring-2 focus:ring-primary outline-none font-semibold text-sm"
                            value={fruitForm.purchase_price}
                            onChange={(e) => setFruitForm({ ...fruitForm, purchase_price: e.target.value })}
                            required
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2">{t('sellingPrice')} (Rs/Kg)</label>
                          <input 
                            type="number" 
                            step="any"
                            className="w-full px-4 py-2.5 rounded-xl border border-outline bg-surface focus:ring-2 focus:ring-primary outline-none font-semibold text-sm"
                            value={fruitForm.selling_price}
                            onChange={(e) => setFruitForm({ ...fruitForm, selling_price: e.target.value })}
                            required
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2">Image URL</label>
                        <input 
                          type="text" 
                          className="w-full px-4 py-2.5 rounded-xl border border-outline bg-surface focus:ring-2 focus:ring-primary outline-none font-semibold text-sm text-outline"
                          placeholder="https://lh3.googleusercontent.com/..."
                          value={fruitForm.image_url}
                          onChange={(e) => setFruitForm({ ...fruitForm, image_url: e.target.value })}
                        />
                      </div>

                      <div className="flex justify-end gap-3 pt-4 border-t border-outline-variant/30">
                        <button 
                          type="button" 
                          onClick={() => setActiveModal(null)}
                          className="px-4 py-2.5 text-outline hover:bg-surface-container-high font-bold rounded-xl text-xs"
                        >
                          {t('cancel')}
                        </button>
                        <button 
                          type="submit"
                          className="px-5 py-2.5 bg-primary text-on-primary font-bold rounded-xl text-xs"
                        >
                          {t('save')}
                        </button>
                      </div>
                    </form>
                  </div>
                )}

                {/* Record Payment */}
                {activeModal === 'record-payment' && (
                  <div>
                    <h3 className="text-xl font-bold text-on-surface mb-2">{t('recordPayment')}</h3>
                    <p className="text-xs text-on-surface-variant mb-6">Customer: <span className="font-bold text-on-surface">{selectedItem.name}</span> | Credit Dues: Rs {parseFloat(selectedItem.balance_due).toFixed(2)}</p>
                    
                    <form onSubmit={handleRecordPayment} className="space-y-4">
                      <div>
                        <label className="block text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2">{t('amountPaid')} (Rs)</label>
                        <input 
                          type="number" 
                          step="any"
                          className="w-full px-4 py-2.5 rounded-xl border border-outline bg-surface focus:ring-2 focus:ring-primary outline-none font-bold text-on-surface text-lg"
                          placeholder={`Max Rs ${parseFloat(selectedItem.balance_due).toFixed(2)}`}
                          value={payForm.amount_paid}
                          onChange={(e) => setPayForm({ ...payForm, amount_paid: e.target.value })}
                          required
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2">{t('paymentMethod')}</label>
                        <select 
                          className="w-full px-4 py-2.5 rounded-xl border border-outline bg-surface focus:ring-2 focus:ring-primary outline-none font-semibold text-sm"
                          value={payForm.payment_method}
                          onChange={(e) => setPayForm({ ...payForm, payment_method: e.target.value })}
                        >
                          <option value="Cash">{t('cash')}</option>
                          <option value="UPI">{t('upi')}</option>
                          <option value="Bank Transfer">{t('bank')}</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2">{t('notes')}</label>
                        <input 
                          type="text" 
                          className="w-full px-4 py-2.5 rounded-xl border border-outline bg-surface focus:ring-2 focus:ring-primary outline-none font-semibold text-sm"
                          placeholder="e.g. Receipt hand delivered"
                          value={payForm.notes}
                          onChange={(e) => setPayForm({ ...payForm, notes: e.target.value })}
                        />
                      </div>

                      <div className="flex justify-end gap-3 pt-4 border-t border-outline-variant/30">
                        <button 
                          type="button" 
                          onClick={() => setActiveModal(null)}
                          className="px-4 py-2.5 text-outline hover:bg-surface-container-high font-bold rounded-xl text-xs"
                        >
                          {t('cancel')}
                        </button>
                        <button 
                          type="submit"
                          className="px-5 py-2.5 bg-primary text-on-primary font-bold rounded-xl text-xs"
                        >
                          {t('save')}
                        </button>
                      </div>
                    </form>
                  </div>
                )}

                {/* View Ledger */}
                {activeModal === 'view-ledger' && selectedItem && (
                  <div className="space-y-6">
                    <div className="flex justify-between items-start border-b border-outline-variant/40 pb-3">
                      <div>
                        <h3 className="text-xl font-bold text-on-surface">{selectedItem.customer.name}</h3>
                        <p className="text-xs text-on-surface-variant font-bold">{selectedItem.customer.phone}</p>
                      </div>
                      <div className="text-right">
                        <span className="text-[10px] font-bold text-outline uppercase tracking-wider">{t('ledgerBalance')}</span>
                        <h4 className="text-lg font-black text-error leading-tight font-mono">Rs {parseFloat(selectedItem.customer.balance_due).toFixed(2)}</h4>
                      </div>
                    </div>

                    <div className="space-y-3">
                      <h4 className="font-bold text-xs text-outline uppercase tracking-wider">{t('purchaseHistory')}</h4>
                      <div className="max-h-40 overflow-y-auto border border-outline-variant/60 rounded-xl space-y-1 p-2 custom-scrollbar bg-surface-container-low">
                        {selectedItem.sales.length === 0 ? (
                          <p className="text-xs text-outline text-center py-4">No purchases logged.</p>
                        ) : (
                          selectedItem.sales.map(s => (
                            <div key={s.id} className="flex justify-between items-center p-2.5 bg-surface-container-lowest border border-outline-variant/30 rounded-lg text-xs font-semibold">
                              <div>
                                <span className="font-bold text-on-surface">Invoice #{s.id}</span>
                                <span className="text-outline ml-2 font-medium">{new Date(s.sale_date).toLocaleDateString()}</span>
                              </div>
                              <span className="text-on-surface font-bold font-mono">Rs {parseFloat(s.total_amount).toFixed(2)}</span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    <div className="space-y-3">
                      <h4 className="font-bold text-xs text-outline uppercase tracking-wider">{t('paymentHistory')}</h4>
                      <div className="max-h-40 overflow-y-auto border border-outline-variant/60 rounded-xl space-y-1 p-2 custom-scrollbar bg-surface-container-low">
                        {selectedItem.payments.length === 0 ? (
                          <p className="text-xs text-outline text-center py-4">No payments logged.</p>
                        ) : (
                          selectedItem.payments.map(p => (
                            <div key={p.id} className="flex justify-between items-center p-2.5 bg-primary/5 border border-primary/20 rounded-lg text-xs font-semibold">
                              <div>
                                <span className="font-bold text-primary">Collected ({p.payment_method})</span>
                                <span className="text-outline ml-2 font-medium">{new Date(p.payment_date).toLocaleDateString()}</span>
                              </div>
                              <span className="text-primary font-black font-mono">- Rs {parseFloat(p.amount_paid).toFixed(2)}</span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    <div className="flex justify-end pt-3 border-t border-outline-variant/30">
                      <button 
                        onClick={() => setActiveModal(null)}
                        className="px-5 py-2 bg-surface-container hover:bg-surface-container-high text-on-surface font-bold rounded-xl text-xs transition-all"
                      >
                        Close Ledger
                      </button>
                    </div>
                  </div>
                )}

                {/* Add Manual Cash Entry */}
                {activeModal === 'add-cash' && (
                  <div>
                    <h3 className="text-xl font-bold text-on-surface mb-6">{t('addCashEntry')}</h3>
                    <form onSubmit={handleSaveCashEntry} className="space-y-4">
                      
                      <div className="grid grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2">{t('entryType')}</label>
                          <select 
                            className="w-full px-4 py-2.5 rounded-xl border border-outline bg-surface focus:ring-2 focus:ring-primary outline-none font-semibold text-sm"
                            value={cashForm.type}
                            onChange={(e) => setCashForm({ ...cashForm, type: e.target.value })}
                          >
                            <option value="cash_out">{t('cashOut')}</option>
                            <option value="cash_in">{t('cashIn')}</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2">{t('category')}</label>
                          <select 
                            className="w-full px-4 py-2.5 rounded-xl border border-outline bg-surface focus:ring-2 focus:ring-primary outline-none font-semibold text-sm"
                            value={cashForm.category}
                            onChange={(e) => setCashForm({ ...cashForm, category: e.target.value })}
                          >
                            <option value="expense">{t('expense')} (Daily operations)</option>
                            <option value="purchase">{t('purchase')} (Farmer purchases)</option>
                            <option value="other">{t('other')}</option>
                          </select>
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2">Amount (Rs)</label>
                        <input 
                          type="number" 
                          step="any"
                          className="w-full px-4 py-2.5 rounded-xl border border-outline bg-surface focus:ring-2 focus:ring-primary outline-none font-bold text-on-surface text-lg"
                          value={cashForm.amount}
                          onChange={(e) => setCashForm({ ...cashForm, amount: e.target.value })}
                          required
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-2">{t('description')}</label>
                        <input 
                          type="text" 
                          className="w-full px-4 py-2.5 rounded-xl border border-outline bg-surface focus:ring-2 focus:ring-primary outline-none font-semibold text-sm"
                          placeholder="e.g. Paid transporter fuel charges"
                          value={cashForm.description}
                          onChange={(e) => setCashForm({ ...cashForm, description: e.target.value })}
                        />
                      </div>

                      <div className="flex justify-end gap-3 pt-4 border-t border-outline-variant/30">
                        <button 
                          type="button" 
                          onClick={() => setActiveModal(null)}
                          className="px-4 py-2.5 text-outline hover:bg-surface-container-high font-bold rounded-xl text-xs"
                        >
                          {t('cancel')}
                        </button>
                        <button 
                          type="submit"
                          className="px-5 py-2.5 bg-primary text-on-primary font-bold rounded-xl text-xs"
                        >
                          {t('save')}
                        </button>
                      </div>
                    </form>
                  </div>
                )}

                {/* Invoice Printable View */}
                {activeModal === 'print-invoice' && selectedItem && (
                  <div className="space-y-6">
                    <div id="invoice-bill-view" className="p-6 border border-outline-variant rounded-xl bg-white space-y-6 text-sm">
                      <div className="flex justify-between items-start">
                        <div>
                          <h2 className="text-xl font-extrabold text-primary leading-none">BUSSINESS CLUB</h2>
                          <p className="text-[10px] text-outline font-bold mt-1 uppercase">Wholesale Fruits Trading Agency</p>
                          <p className="text-[9px] text-outline font-medium">Gate No. 2, Wholesale Produce Market</p>
                        </div>
                        <div className="text-right">
                          <h3 className="font-extrabold text-on-surface text-base">BILL INVOICE</h3>
                          <p className="text-xs text-outline font-mono">ID: #{selectedItem.sale.id}</p>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4 border-t border-b border-outline-variant/40 py-3 text-xs">
                        <div>
                          <p className="text-outline font-bold">CLIENT:</p>
                          <p className="font-bold text-on-surface mt-1">{selectedItem.sale.customer_name}</p>
                          <p className="text-on-surface-variant font-mono">{selectedItem.sale.customer_phone}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-outline font-bold">DETAILS:</p>
                          <p className="text-on-surface mt-1"><span className="font-bold">Date:</span> {new Date(selectedItem.sale.sale_date).toLocaleDateString()}</p>
                          <p className="text-on-surface"><span className="font-bold">Staff:</span> {selectedItem.sale.user_name || 'System'}</p>
                        </div>
                      </div>

                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="border-b border-outline-variant text-outline font-bold uppercase text-[9px]">
                            <th className="py-2">Fruit Name</th>
                            <th className="py-2 text-right">Qty (Kg)</th>
                            <th className="py-2 text-right">Rate</th>
                            <th className="py-2 text-right">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedItem.items.map((item, idx) => (
                            <tr key={idx} className="border-b border-outline-variant/30 font-semibold text-on-surface-variant">
                              <td className="py-2 font-bold text-on-surface">{item.fruit_name}</td>
                              <td className="py-2 text-right font-mono">{parseFloat(item.quantity).toFixed(1)}</td>
                              <td className="py-2 text-right font-mono">Rs {parseFloat(item.price).toFixed(2)}</td>
                              <td className="py-2 text-right text-on-surface font-bold font-mono">Rs {parseFloat(item.total).toFixed(2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>

                      <div className="flex justify-end text-xs font-bold text-on-surface-variant border-t border-outline-variant/30 pt-4">
                        <div className="w-48 space-y-1.5 text-right font-mono">
                          <div className="flex justify-between">
                            <span>Total Bill:</span>
                            <span className="text-on-surface font-extrabold">Rs {parseFloat(selectedItem.sale.total_amount).toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between">
                            <span>Paid Upfront:</span>
                            <span className="text-primary font-bold">Rs {parseFloat(selectedItem.sale.paid_amount).toFixed(2)}</span>
                          </div>
                          <div className="flex justify-between text-error font-black border-t border-outline-variant/20 pt-1.5">
                            <span>Credit Dues:</span>
                            <span>Rs {parseFloat(selectedItem.sale.balance_due).toFixed(2)}</span>
                          </div>
                        </div>
                      </div>

                      {selectedItem.sale.due_date && (
                        <p className="text-[10px] text-secondary font-bold text-center bg-secondary-fixed/30 py-2 rounded-lg">
                          Settlement Dues Date: {new Date(selectedItem.sale.due_date).toLocaleDateString()}
                        </p>
                      )}

                      <p className="text-[9px] text-outline text-center font-bold italic pt-4 border-t border-outline-variant/20 uppercase tracking-wider">
                        Computer generated invoice. Thank you!
                      </p>
                    </div>

                    <div className="flex justify-end gap-3 pt-3 border-t border-outline-variant/30">
                      <button 
                        onClick={() => setActiveModal(null)}
                        className="px-4 py-2 bg-surface-container hover:bg-surface-container-high text-on-surface font-bold rounded-xl text-xs transition-all"
                      >
                        Close
                      </button>
                      <button 
                        onClick={() => {
                          const printWindow = window.open('', '_blank');
                          const invoiceHtml = document.getElementById('invoice-bill-view').innerHTML;
                          printWindow.document.write(`
                            <html>
                              <head>
                                <title>Invoice #${selectedItem.sale.id}</title>
                                <link href="https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css" rel="stylesheet">
                                <style>
                                  body { font-family: sans-serif; padding: 40px; }
                                </style>
                              </head>
                              <body onload="window.print(); window.close();">
                                <div class="max-w-md mx-auto">${invoiceHtml}</div>
                              </body>
                            </html>
                          `);
                          printWindow.document.close();
                        }}
                        className="px-5 py-2 bg-primary text-on-primary font-bold rounded-xl text-xs transition-all flex items-center gap-1.5 shadow-md shadow-primary/20"
                      >
                        <span className="material-symbols-outlined text-[16px]">print</span>
                        <span>{t('printInvoice')}</span>
                      </button>
                    </div>
                  </div>
                )}

              </div>
            </div>
          )}

          {/* ======================================================== */}
          {/* DEVELOPER MOCK LOGIN MODAL */}
          {/* ======================================================== */}
          {showMockLoginModal && (
            <div className="no-print fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
              <div className="bg-surface-container-lowest rounded-3xl shadow-2xl p-6 md:p-8 max-w-sm w-full animate-fade-in relative border border-outline-variant/30">
                <h3 className="text-lg font-bold text-on-surface mb-2">Developer Google Auth Bypass</h3>
                <p className="text-xs text-on-surface-variant mb-6">Select a profile to simulate login or type a custom Google email account.</p>
                
                <form onSubmit={handleMockLoginSubmit} className="space-y-4">
                  <div>
                    <label className="block text-[10px] font-bold text-outline uppercase tracking-wider mb-2">Pre-Seeded Accounts</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button 
                        type="button"
                        onClick={() => setMockEmailInput('owner@bussinessclub.com')}
                        className={`py-2 px-3 rounded-lg text-xs font-bold border transition-all ${
                          mockEmailInput === 'owner@bussinessclub.com' 
                            ? 'bg-primary text-on-primary border-transparent' 
                            : 'bg-surface hover:bg-slate-100 border-outline-variant text-slate-700'
                        }`}
                      >
                        owner@bussinessclub.com
                      </button>
                      <button 
                        type="button"
                        onClick={() => setMockEmailInput('staff@bussinessclub.com')}
                        className={`py-2 px-3 rounded-lg text-xs font-bold border transition-all ${
                          mockEmailInput === 'staff@bussinessclub.com' 
                            ? 'bg-primary text-on-primary border-transparent' 
                            : 'bg-surface hover:bg-slate-100 border-outline-variant text-slate-700'
                        }`}
                      >
                        staff@bussinessclub.com
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] font-bold text-outline uppercase tracking-wider mb-2">Custom Mock Email</label>
                    <input 
                      type="email" 
                      className="w-full px-4 py-2 border border-outline bg-surface rounded-xl text-xs font-semibold focus:outline-none focus:border-primary"
                      placeholder="e.g. operator@gmail.com"
                      value={mockEmailInput}
                      onChange={(e) => setMockEmailInput(e.target.value)}
                      required
                    />
                  </div>

                  <div className="flex justify-end gap-3 pt-4 border-t border-outline-variant/30">
                    <button 
                      type="button" 
                      onClick={() => setShowMockLoginModal(false)}
                      className="px-4 py-2 text-outline hover:bg-surface-container-high font-bold rounded-xl text-xs"
                    >
                      {t('cancel')}
                    </button>
                    <button 
                      type="submit"
                      className="px-5 py-2 bg-primary text-on-primary font-bold rounded-xl text-xs"
                    >
                      Mock Sign In
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

        </>
      )}
    </div>
  );
}
