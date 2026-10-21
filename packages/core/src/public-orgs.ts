import { fold } from './normalize';

/**
 * Organizations every Quebecer deals with: governments and public bodies,
 * banks and insurers, utilities and big brands. Their names identify no one
 * and help an AI understand the document, so they stay as written; any other
 * company (a numbered company, a holding, a small business) is replaced.
 */
const PUBLIC = [
  // Governments, public bodies, professional orders
  'gouvernement', 'government', 'ministere', 'ministry', 'revenu quebec', 'agence du revenu', 'canada revenue', 'registraire des entreprises',
  'registre foncier', 'publicite des droits', 'cadastre du quebec', 'ville de', 'city of', 'municipalite', 'mrc ', 'centre de services scolaire',
  'commission scolaire', 'cegep', 'universite', 'university', 'hydro-quebec', 'hydro quebec', 'saaq', 'ramq', 'cnesst', 'retraite quebec',
  'regie du', 'tribunal administratif', 'ordre des', 'chambre des notaires', 'barreau du', 'oaciq', "organisme d'autoreglementation",
  "organisme d’autoreglementation", "societe canadienne d'hypotheques", 'schl', 'cmhc', "societe d'habitation du quebec", 'postes canada',
  'canada post', 'service canada', 'emploi-quebec', 'surete du quebec', 'ciusss', 'cisss', 'investissement quebec', 'financiere agricole',
  'clicsequr', 'gouv.qc.ca', 'mon dossier', 'services quebec', 'service quebec', 'post canada', 'association des inspecteurs', 'cprst', 'ccts',
  'agence de la consommation', 'office de la protection du consommateur', 'protecteur du citoyen', 'elections quebec', 'statistique canada',
  // Banks, credit unions, insurers, lenders
  'desjardins', 'banque nationale', 'national bank', 'rbc', 'banque royale', 'royal bank', 'banque td', 'td canada', 'toronto-dominion', 'bmo',
  'banque de montreal', 'bank of montreal', 'scotia', 'cibc', 'banque laurentienne', 'laurentian bank', 'hsbc', 'tangerine', 'simplii', 'manuvie',
  'manulife', 'sun life', 'la capitale', 'beneva', 'ssq', 'industrielle alliance', 'ia groupe financier', 'intact', 'aviva', 'promutuel',
  'td assurance', 'belairdirect', 'wawanesa', 'co-operators', 'equitable', 'first national', 'mcap', 'merix', 'home trust', 'sagen', 'genworth',
  'canada guaranty', 'equifax', 'transunion', 'visa', 'mastercard', 'american express', 'interac', 'paypal',
  // Utilities, telecoms, big brands, real-estate networks
  'bell', 'videotron', 'cogeco', 'rogers', 'telus', 'fizz', 'koodo', 'energir', 'gaz metro', 'amazon', 'google', 'apple', 'microsoft', 'costco',
  'ikea', 'home depot', 'rona', 'canadian tire', 'reno-depot', 'bmr', 'walmart', 'metro inc', 'provigo', 'sobeys', 'uber', 'airbnb', 'docusign',
  'adobe', 'centris', 'realtor', 're/max', 'remax', 'royal lepage', 'via capitale', 'sutton', 'duproprio', 'proprio direct', 'kijiji', 'marketplace',
  'u-haul', 'uhaul', 'shaw', 'netflix', 'spotify', 'tim hortons', 'mcdonald', 'starbucks', 'jean coutu', 'pharmaprix', 'familiprix', 'uniprix',
];

const PATTERN = new RegExp(`(?:^|[^a-z0-9])(?:${PUBLIC.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?:$|[^a-z0-9])`);

export function isPublicOrg(name: string): boolean {
  return PATTERN.test(fold(name).replace(/[’]/g, "'"));
}
