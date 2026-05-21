const personasCtrl = require("./personas.controller");

exports.previewExpedientePdf = async (req, res) => {
  return personasCtrl.getPerfilPdf(req, res);
};
