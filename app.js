
// Charger les variables d'environnement
require('dotenv').config();

// Importer les dépendances
const admin = require('firebase-admin');
const sgMail = require('@sendgrid/mail');
const express = require('express');

// Initialiser Express
const app = express();
const PORT = process.env.PORT || 3000;

// Initialiser Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

// Initialiser SendGrid
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

// Templates email
const emailTemplates = {
  driver_confirm: {
    subject: 'Course confirmée par votre chauffeur',
    sendgridTemplateId: 'd-81602ae7361f4254b28d4ca883226242',
  },
  driver_cancel: {
    subject: 'Annulation de votre course',
    sendgridTemplateId: 'd-a4ddb97407384b4fbb9b631ac4e35d57',
  }
};

// Référence à Firestore
const db = admin.firestore();

// Fonction pour gérer les changements de statut
const handleReservationStatusChange = async (reservationId, reservationData) => {
  try {
    console.log(`🔍 Traitement de la réservation ${reservationId} (statut: ${reservationData.status})`);

    // Récupérer les infos du chauffeur
    const driverDoc = await db.collection('drivers').doc(reservationData.driverId).get();
    const driverData = driverDoc.data();

    if (!driverData) {
      console.error(`❌ Aucun chauffeur trouvé avec l'ID: ${reservationData.driverId}`);
      return;
    }

    // Préparer les données pour l'email (adapté à votre structure de données)
    const emailData = {
      reservationId: reservationId.substring(0, 8),
      clientName: reservationData.name || 'Client', // Champ direct
      driverName: driverData.name || 'Votre chauffeur',
      driverPhone: driverData.phone || 'Non disponible',
      date: new Date(reservationData.date), // Conversion de la chaîne en Date
      trip: {
        from: reservationData.trip?.from || 'Non spécifié',
        to: reservationData.trip?.to || 'Non spécifié'
      },
      price: reservationData.price || 0
    };

    // Déterminer le template à utiliser
    const templateType = `driver_${reservationData.status}`;
    const template = emailTemplates[templateType];
    const clientEmail = reservationData.email; // Champ direct

    if (!template) {
      console.warn(`⚠️ Template non trouvé pour le type: ${templateType}`);
      return;
    }

    if (!clientEmail) {
      console.warn(`⚠️ Aucun email client pour la réservation ${reservationId}`);
      return;
    }

    // Préparer le message SendGrid
    const msg = {
      to: clientEmail,
      from: {
        email: process.env.SENDGRID_FROM_EMAIL, // Correction de la faute de frappe (SENDGRID au lieu de SENDGRID)
        name: 'DriverPro Notifications'
      },
      subject: template.subject,
      templateId: template.sendgridTemplateId,
      dynamic_template_data: {
        clientName: emailData.clientName,
        driverName: emailData.driverName,
        reservationId: emailData.reservationId,
        date: emailData.date.toLocaleString('fr-FR', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        }),
        trip: emailData.trip,
        price: emailData.price.toFixed(2),
        driverPhone: emailData.driverPhone
      }
    };

    console.log('✉️ Tentative d\'envoi d\'email avec:', {
      to: msg.to,
      templateId: msg.templateId
    });

    await sgMail.send(msg);
    console.log(`✅ Email envoyé avec succès à ${clientEmail}`);
  } catch (error) {
    console.error('❌ Erreur dans handleReservationStatusChange:', error);
    if (error.response) {
      console.error('Détails de l\'erreur SendGrid:', error.response.body);
    }
    throw error;
  }
};

// Écouteur Firestore
const setupReservationListener = () => {
  console.log('🔄 Initialisation de l\'écouteur Firestore...');

  return db.collection('reservations')
    .where('status', 'in', ['confirmed', 'cancelled'])
    .onSnapshot(
      async (snapshot) => {
        console.log(`📡 ${snapshot.docChanges().length} changement(s) détecté(s)`);
        
        for (const change of snapshot.docChanges()) {
          if (change.type === 'modified') {
            const reservationId = change.doc.id;
            const newData = change.doc.data();
            const previousData = change.doc.previous.data; // Sans parenthèses

            console.log(`🔄 Modification réservation ${reservationId}:`, {
              ancienStatut: previousData.status,
              nouveauStatut: newData.status
            });

            try {
              await handleReservationStatusChange(reservationId, newData);
            } catch (error) {
              console.error(`❌ Échec du traitement pour ${reservationId}:`, error);
            }
          }
        }
      },
      (error) => {
        console.error('🔥 Erreur Firestore:', error);
        setTimeout(setupReservationListener, 5000);
      }
    );
};

// Gestion des erreurs
process.on('uncaughtException', (error) => {
  console.error('🚨 Erreur non capturée:', error);
  if (reservationListener) reservationListener();
  setTimeout(setupReservationListener, 5000);
});

// Route de test
app.get('/test-email', async (req, res) => {
  try {
    const msg = {
      to: 'wdjegui45@gmail.com',
      from: process.env.SENDGRID_FROM_EMAIL,
      subject: 'Test technique',
      text: 'Ceci est un test technique'
    };
    
    await sgMail.send(msg);
    res.send('Email de test envoyé avec succès');
  } catch (error) {
    console.error('Erreur test email:', error);
    res.status(500).send('Erreur lors de l\'envoi du test');
  }
});

// Endpoint de vérification
app.get('/', (req, res) => {
  res.status(200).send('✅ Service DriverPro Notifications actif.');
});

// Démarrer le serveur
let reservationListener = setupReservationListener();

app.listen(PORT, () => {
  console.log(`🚀 Service en écoute sur le port ${PORT}`);
});
