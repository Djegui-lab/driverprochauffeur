// Configuration initiale et imports
require('dotenv').config({ path: process.env.NODE_ENV === 'production' ? '.env.prod' : '.env' });

const admin = require('firebase-admin');
const sgMail = require('@sendgrid/mail');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// Initialisation de l'application
const app = express();
const PORT = process.env.PORT || 8080;

// Middlewares de sécurité
app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limite chaque IP à 100 requêtes par fenêtre
});
app.use(limiter);

// Validation des variables d'environnement
const requiredEnvVars = [
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_DATABASE_URL',
  'SENDGRID_API_KEY',
  'SENDGRID_FROM_EMAIL'
];

const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
  console.error('❌ Variables d\'environnement manquantes:', missingVars);
  process.exit(1);
}

// Configuration Firebase Admin
try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
  console.log('✅ Firebase Admin initialisé');
} catch (error) {
  console.error('❌ Erreur d\'initialisation Firebase:', error);
  process.exit(1);
}

// Configuration SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
console.log('✅ SendGrid configuré');

// Templates email
const emailTemplates = {
  driver_confirm: {
    subject: 'Course confirmée par votre chauffeur',
    templateId: 'd-81602ae7361f4254b28d4ca883226242',
  },
  driver_cancel: {
    subject: 'Annulation de votre course',
    templateId: 'd-a4ddb97407384b4fbb9b631ac4e35d57',
  }
};

// Database reference
const db = admin.firestore();
const reservationsRef = db.collection('reservations');

// Fonction pour formater la date
const formatDate = (dateString) => {
  const date = new Date(dateString);
  return date.toLocaleString('fr-FR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

// Gestion des statuts de réservation
async function handleReservationStatusChange(reservationId, reservationData) {
  try {
    console.log(`🔍 Traitement réservation ${reservationId}`);

    // Récupération des données du chauffeur
    const driverDoc = await db.collection('drivers').doc(reservationData.driverId).get();
    if (!driverDoc.exists) {
      throw new Error(`Chauffeur ${reservationData.driverId} introuvable`);
    }

    const driverData = driverDoc.data();
    const clientEmail = reservationData.email;
    
    if (!clientEmail) {
      throw new Error('Email client manquant');
    }

    // Préparation des données pour l'email
    const emailData = {
      reservationId: reservationId.substring(0, 8),
      clientName: reservationData.name || 'Client',
      driverName: driverData.name || 'Votre chauffeur',
      driverPhone: driverData.phone || 'Non disponible',
      date: formatDate(reservationData.date),
      trip: {
        from: reservationData.trip?.from || 'Non spécifié',
        to: reservationData.trip?.to || 'Non spécifié'
      },
      price: (reservationData.price || 0).toFixed(2)
    };

    const templateType = `driver_${reservationData.status}`;
    const template = emailTemplates[templateType];
    
    if (!template) {
      throw new Error(`Template ${templateType} non trouvé`);
    }

    // Construction du message SendGrid
    const msg = {
      to: clientEmail,
      from: {
        email: process.env.SENDGRID_FROM_EMAIL,
        name: 'DriverPro Notifications'
      },
      subject: template.subject,
      templateId: template.templateId,
      dynamic_template_data: emailData
    };

    console.log('✉️ Envoi email à:', clientEmail);
    await sgMail.send(msg);
    console.log('✅ Email envoyé avec succès');

  } catch (error) {
    console.error('❌ Erreur:', error.message);
    if (error.response) {
      console.error('Détails SendGrid:', error.response.body);
    }
    throw error;
  }
}

// Écouteur Firestore
function setupReservationListener() {
  console.log('🔄 Initialisation écouteur Firestore...');

  return reservationsRef
    .where('status', 'in', ['confirmed', 'cancelled'])
    .onSnapshot(
      async (snapshot) => {
        console.log(`📡 ${snapshot.docChanges().length} changement(s)`);
        
        for (const change of snapshot.docChanges()) {
          if (change.type === 'modified') {
            try {
              await handleReservationStatusChange(change.doc.id, change.doc.data());
            } catch (error) {
              console.error(`Échec traitement réservation ${change.doc.id}:`, error.message);
            }
          }
        }
      },
      (error) => {
        console.error('🔥 Erreur Firestore:', error);
        setTimeout(setupReservationListener, 5000);
      }
    );
}

// Gestion des erreurs globales
process.on('unhandledRejection', (error) => {
  console.error('🚨 Rejet non géré:', error);
});

process.on('uncaughtException', (error) => {
  console.error('🚨 Exception non capturée:', error);
  process.exit(1);
});

// Routes API
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Service DriverPro Notifications actif',
    timestamp: new Date().toISOString()
  });
});

app.get('/test-email', async (req, res) => {
  try {
    const msg = {
      to: process.env.TEST_EMAIL || 'test@example.com',
      from: process.env.SENDGRID_FROM_EMAIL,
      subject: 'Test technique DriverPro',
      text: 'Ceci est un test technique du service de notifications',
      html: '<strong>Ceci est un test technique</strong>'
    };
    
    await sgMail.send(msg);
    res.json({ status: 'success', message: 'Email de test envoyé' });
  } catch (error) {
    console.error('Erreur test email:', error);
    res.status(500).json({ 
      status: 'error',
      message: 'Échec envoi email',
      error: error.message 
    });
  }
});

// Démarrage du serveur
let server;
let reservationListener;

async function startServer() {
  try {
    reservationListener = setupReservationListener();
    
    server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Serveur en écoute sur le port ${PORT}`);
      console.log(`🔗 Environnement: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('Échec démarrage serveur:', error);
    process.exit(1);
  }
}

// Gestion propre des arrêts
process.on('SIGTERM', () => {
  console.log('🛑 Réception SIGTERM - Arrêt propre');
  if (reservationListener) reservationListener();
  if (server) server.close(() => {
    console.log('🔴 Serveur arrêté');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 Réception SIGINT - Arrêt propre');
  if (reservationListener) reservationListener();
  if (server) server.close(() => {
    console.log('🔴 Serveur arrêté');
    process.exit(0);
  });
});

// Démarrer l'application
startServer();
