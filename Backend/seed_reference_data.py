"""
Seeds the static clinical reference data into MongoDB.

Run once after setting up your Atlas cluster:

    python seed_reference_data.py

This replaces medicine_chatbot_schema.sql and seed_drug_classes.sql.
There is no CREATE TABLE step any more — Mongo creates collections on
first insert — so this script only needs to create indexes and load the
reference data.

WHAT COUNTS AS REFERENCE DATA
-----------------------------
Everything here is static clinical knowledge, identical for every patient,
curated by hand. It is NOT patient data and is never touched by /survey.
This is the piece the project plan assigns to Person C as the "knowledge
base", and it is what makes the safety filter deterministic rather than
dependent on the model.
"""

import sys

from app.database import get_db, ensure_indexes, ping


# ==========================================================
# Drug classes — from your original seed_drug_classes.sql,
# extended to cover the common OTC medicines the bot will actually reach for
# ==========================================================

DRUG_CLASS_MEMBERS = [
    # penicillins
    ("penicillins", "penicillin"),
    ("penicillins", "penicillin v"),
    ("penicillins", "amoxicillin"),
    ("penicillins", "ampicillin"),
    ("penicillins", "piperacillin"),
    ("penicillins", "flucloxacillin"),
    ("penicillins", "co-amoxiclav"),

    # cephalosporins
    ("cephalosporins", "cephalexin"),
    ("cephalosporins", "cefuroxime"),
    ("cephalosporins", "ceftriaxone"),
    ("cephalosporins", "cefdinir"),
    ("cephalosporins", "cefixime"),

    # sulfonamides
    ("sulfonamides", "sulfamethoxazole"),
    ("sulfonamides", "sulfasalazine"),
    ("sulfonamides", "trimethoprim-sulfamethoxazole"),
    ("sulfonamides", "co-trimoxazole"),

    # NSAIDs — the most important class for an OTC bot
    ("nsaids", "ibuprofen"),
    ("nsaids", "naproxen"),
    ("nsaids", "aspirin"),
    ("nsaids", "diclofenac"),
    ("nsaids", "mefenamic acid"),
    ("nsaids", "ketoprofen"),
    ("nsaids", "celecoxib"),

    # macrolides
    ("macrolides", "erythromycin"),
    ("macrolides", "azithromycin"),
    ("macrolides", "clarithromycin"),

    # antihistamines — sedating
    ("sedating_antihistamines", "diphenhydramine"),
    ("sedating_antihistamines", "chlorpheniramine"),
    ("sedating_antihistamines", "promethazine"),
    ("sedating_antihistamines", "hydroxyzine"),

    # antihistamines — non-sedating
    ("nonsedating_antihistamines", "cetirizine"),
    ("nonsedating_antihistamines", "loratadine"),
    ("nonsedating_antihistamines", "fexofenadine"),
    ("nonsedating_antihistamines", "levocetirizine"),

    # analgesics
    ("paracetamol_group", "paracetamol"),
    ("paracetamol_group", "acetaminophen"),

    # opioids
    ("opioids", "codeine"),
    ("opioids", "tramadol"),
    ("opioids", "morphine"),
    ("opioids", "dihydrocodeine"),

    # PPIs
    ("proton_pump_inhibitors", "omeprazole"),
    ("proton_pump_inhibitors", "esomeprazole"),
    ("proton_pump_inhibitors", "pantoprazole"),
    ("proton_pump_inhibitors", "lansoprazole"),

    # antacids / H2
    ("h2_blockers", "ranitidine"),
    ("h2_blockers", "famotidine"),
    ("h2_blockers", "cimetidine"),

    # decongestants
    ("decongestants", "pseudoephedrine"),
    ("decongestants", "phenylephrine"),
    ("decongestants", "oxymetazoline"),
]


# ==========================================================
# Condition contraindications  (NEW)
#
# These are the checks that were previously left entirely to the prompt.
# target_type "class" matches any member of that drug class; "medicine"
# matches by name.
# ==========================================================

CONDITION_CONTRAINDICATIONS = [
    {"condition_keyword": "asthma", "target": "nsaids", "target_type": "class",
     "reason": "NSAIDs can trigger bronchospasm in people with asthma"},
    {"condition_keyword": "asthma", "target": "aspirin", "target_type": "medicine",
     "reason": "aspirin-exacerbated respiratory disease is a recognised risk in asthma"},

    {"condition_keyword": "peptic ulcer", "target": "nsaids", "target_type": "class",
     "reason": "NSAIDs irritate the stomach lining and can cause bleeding"},
    {"condition_keyword": "ulcer", "target": "nsaids", "target_type": "class",
     "reason": "NSAIDs irritate the stomach lining and can cause bleeding"},
    {"condition_keyword": "gastritis", "target": "nsaids", "target_type": "class",
     "reason": "NSAIDs worsen gastric irritation"},
    {"condition_keyword": "gerd", "target": "nsaids", "target_type": "class",
     "reason": "NSAIDs can aggravate reflux and gastric irritation"},
    {"condition_keyword": "acid reflux", "target": "nsaids", "target_type": "class",
     "reason": "NSAIDs can aggravate reflux and gastric irritation"},

    {"condition_keyword": "kidney disease", "target": "nsaids", "target_type": "class",
     "reason": "NSAIDs reduce kidney blood flow and can worsen renal function"},
    {"condition_keyword": "renal", "target": "nsaids", "target_type": "class",
     "reason": "NSAIDs reduce kidney blood flow and can worsen renal function"},
    {"condition_keyword": "chronic kidney", "target": "nsaids", "target_type": "class",
     "reason": "NSAIDs reduce kidney blood flow and can worsen renal function"},

    {"condition_keyword": "liver disease", "target": "paracetamol_group", "target_type": "class",
     "reason": "paracetamol is metabolised by the liver and needs dose reduction or avoidance"},
    {"condition_keyword": "cirrhosis", "target": "paracetamol_group", "target_type": "class",
     "reason": "paracetamol is metabolised by the liver and needs dose reduction or avoidance"},
    {"condition_keyword": "hepatitis", "target": "paracetamol_group", "target_type": "class",
     "reason": "paracetamol is metabolised by the liver and needs dose reduction or avoidance"},

    {"condition_keyword": "hypertension", "target": "decongestants", "target_type": "class",
     "reason": "decongestants raise blood pressure"},
    {"condition_keyword": "high blood pressure", "target": "decongestants", "target_type": "class",
     "reason": "decongestants raise blood pressure"},
    {"condition_keyword": "hypertension", "target": "nsaids", "target_type": "class",
     "reason": "NSAIDs raise blood pressure and reduce the effect of antihypertensives"},

    {"condition_keyword": "heart failure", "target": "nsaids", "target_type": "class",
     "reason": "NSAIDs cause fluid retention and can worsen heart failure"},
    {"condition_keyword": "heart disease", "target": "decongestants", "target_type": "class",
     "reason": "decongestants increase heart rate and blood pressure"},

    {"condition_keyword": "glaucoma", "target": "sedating_antihistamines", "target_type": "class",
     "reason": "anticholinergic effects can raise intraocular pressure"},

    {"condition_keyword": "epilepsy", "target": "tramadol", "target_type": "medicine",
     "reason": "tramadol lowers the seizure threshold"},

    {"condition_keyword": "bleeding disorder", "target": "nsaids", "target_type": "class",
     "reason": "NSAIDs impair platelet function and increase bleeding risk"},
    {"condition_keyword": "haemophilia", "target": "nsaids", "target_type": "class",
     "reason": "NSAIDs impair platelet function and increase bleeding risk"},
]


# ==========================================================
# Pregnancy contraindications  (NEW)
# ==========================================================

PREGNANCY_CONTRAINDICATIONS = [
    {"target": "nsaids", "target_type": "class",
     "applies_to": ["pregnant"],
     "reason": "NSAIDs are avoided in pregnancy, particularly in the third trimester"},
    {"target": "aspirin", "target_type": "medicine",
     "applies_to": ["pregnant", "breastfeeding"],
     "reason": "aspirin is avoided in pregnancy and while breastfeeding unless a doctor has advised it"},
    {"target": "codeine", "target_type": "medicine",
     "applies_to": ["pregnant", "breastfeeding"],
     "reason": "codeine passes into breast milk and is avoided in pregnancy"},
    {"target": "opioids", "target_type": "class",
     "applies_to": ["pregnant", "breastfeeding"],
     "reason": "opioids are avoided in pregnancy and while breastfeeding without specialist advice"},
    {"target": "pseudoephedrine", "target_type": "medicine",
     "applies_to": ["pregnant", "breastfeeding"],
     "reason": "decongestants are generally avoided in pregnancy and can reduce milk supply"},
    {"target": "decongestants", "target_type": "class",
     "applies_to": ["pregnant", "breastfeeding"],
     "reason": "decongestants are generally avoided in pregnancy and can reduce milk supply"},
]


def seed():
    ok, message = ping()
    if not ok:
        print(f"ERROR: {message}")
        print("\nCheck that MONGODB_URI in your .env is correct, and that your")
        print("current IP address is whitelisted in Atlas under Network Access.")
        sys.exit(1)

    print(f"Connected. {message}\n")

    db = get_db()

    print("Creating indexes...")
    ensure_indexes()

    # Reference collections are replaced wholesale on each run so the script
    # is safe to re-run after editing the lists above. Patient data is never
    # touched.
    print("Seeding drug_class_members...")
    db.drug_class_members.delete_many({})
    db.drug_class_members.insert_many([
        {"class_name": c, "medicine_name": m} for c, m in DRUG_CLASS_MEMBERS
    ])
    print(f"  {len(DRUG_CLASS_MEMBERS)} entries")

    print("Seeding condition_contraindications...")
    db.condition_contraindications.delete_many({})
    db.condition_contraindications.insert_many(CONDITION_CONTRAINDICATIONS)
    print(f"  {len(CONDITION_CONTRAINDICATIONS)} rules")

    print("Seeding pregnancy_contraindications...")
    db.pregnancy_contraindications.delete_many({})
    db.pregnancy_contraindications.insert_many(PREGNANCY_CONTRAINDICATIONS)
    print(f"  {len(PREGNANCY_CONTRAINDICATIONS)} rules")

    print("\nDone. Reference data seeded.")
    print(f"Patients on file: {db.patients.count_documents({})}")


if __name__ == "__main__":
    seed()
