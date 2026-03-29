// ═══════════════════════════════════════════════════════════════
// Google Apps Script — Backend API pour les témoignages Harmony Flux
// ═══════════════════════════════════════════════════════════════
//
// INSTRUCTIONS DE DÉPLOIEMENT :
// 1. Créez un nouveau Google Sheet (https://sheets.google.com)
// 2. Renommez la première feuille en "Témoignages"
// 3. Ajoutez ces en-têtes en ligne 1 :
//    A1: id | B1: date | C1: prenom | D1: ville | E1: note
//    F1: soin | G1: modalite | H1: texte | I1: statut
// 4. Dans le Google Sheet, allez dans Extensions > Apps Script
// 5. Collez tout ce code dans l'éditeur
// 6. Cliquez sur "Déployer" > "Nouveau déploiement"
// 7. Type : "Application Web"
// 8. Exécuter en tant que : "Moi"
// 9. Accès : "Tout le monde"
// 10. Copiez l'URL du déploiement et remplacez-la dans le site (variable APPS_SCRIPT_URL)
//
// MODÉRATION :
// - Chaque nouveau témoignage arrive avec statut "en_attente"
// - Pour l'approuver, changez la cellule I (statut) en "approuve"
// - Seuls les témoignages "approuve" s'affichent sur le site
// ═══════════════════════════════════════════════════════════════

const SHEET_NAME = 'Témoignages';

// ── GET : Renvoie les témoignages approuvés ──
function doGet(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAME);
    
    if (!sheet || sheet.getLastRow() < 2) {
      return jsonResponse({ success: true, temoignages: [] });
    }
    
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const temoignages = [];
    
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const statut = (row[8] || '').toString().trim().toLowerCase();
      
      // Ne renvoyer que les témoignages approuvés
      if (statut === 'approuve' || statut === 'approuvé') {
        temoignages.push({
          id: row[0],
          date: row[1],
          prenom: row[2],
          ville: row[3],
          note: row[4],
          soin: row[5],
          modalite: row[6],
          texte: row[7]
        });
      }
    }
    
    return jsonResponse({ success: true, temoignages: temoignages });
    
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// ── POST : Ajoute un nouveau témoignage ──
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    
    // Validation basique
    if (!body.prenom || !body.texte || !body.note) {
      return jsonResponse({ success: false, error: 'Champs obligatoires manquants.' });
    }
    
    // Anti-spam basique : limiter la longueur
    const prenom = body.prenom.toString().substring(0, 50);
    const ville = (body.ville || '').toString().substring(0, 80);
    const texte = body.texte.toString().substring(0, 400);
    const note = Math.min(5, Math.max(1, parseInt(body.note) || 5));
    const soin = (body.soin || '').toString().substring(0, 50);
    const modalite = (body.modalite || '').toString().substring(0, 30);
    
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAME);
    
    if (!sheet) {
      return jsonResponse({ success: false, error: 'Feuille introuvable.' });
    }
    
    const id = new Date().getTime().toString();
    const date = Utilities.formatDate(new Date(), 'Europe/Paris', 'yyyy-MM-dd');
    
    sheet.appendRow([id, date, prenom, ville, note, soin, modalite, texte, 'en_attente']);
    
    return jsonResponse({ success: true, message: 'Témoignage enregistré. Il sera visible après modération.' });
    
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
