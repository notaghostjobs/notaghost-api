// A skills and tools dictionary for requirement-level matching. Each entry: a canonical id, the words that name it
// (matched whole, case-insensitive), and a family. Within a family some skills transfer to others with a stated weight
// (React → Angular 0.5); across families nothing transfers. Java is not JavaScript; Node.js is not "backend".
// Written by hand from the postings' own vocabulary. Offline lab code.

export type Skill = { id: string; re: RegExp; family: string };
const S: [string, string, string][] = [
  // languages
  ["java", String.raw`java(?!\s*script)|core java|j2ee|jvm`, "lang"],
  ["javascript", String.raw`javascript|js(?=\s|,|/)|es6|ecmascript`, "lang"],
  ["typescript", String.raw`typescript|\bts\b`, "lang"],
  ["python", String.raw`python|pyspark|pandas|numpy`, "lang"],
  ["golang", String.raw`golang|\bgo\b(?= (lang|developer|engineer|services))`, "lang"],
  ["csharp", String.raw`c#|\.net|dotnet|asp\.net`, "lang"],
  ["cpp", String.raw`c\+\+|\bcpp\b`, "lang"],
  ["c", String.raw`\bc programming|embedded c|\bc\b(?=[ ,/]+(c\+\+|embedded|linux|rtos))`, "lang"],
  ["kotlin", String.raw`kotlin`, "lang"], ["swift", String.raw`swift(?!\s*code)|swiftui`, "lang"], ["scala", String.raw`scala\b`, "lang"],
  ["php", String.raw`\bphp\b|laravel`, "lang"], ["ruby", String.raw`ruby|rails`, "lang"], ["rust", String.raw`\brust\b`, "lang"],
  ["abap", String.raw`abap`, "sap"], ["apex", String.raw`\bapex\b|lightning web components|\blwc\b|visualforce`, "salesforce"],
  // backend frameworks / runtimes
  ["nodejs", String.raw`node\.?js|\bnode\b|express\.?js|nest\.?js`, "backend"],
  ["spring", String.raw`spring boot|spring\b|hibernate`, "backend"],
  ["fastapi", String.raw`fastapi|django|flask`, "backend"],
  ["microservices", String.raw`microservices?|micro-services`, "arch"], ["rest", String.raw`rest(ful)? api|rest services|graphql`, "arch"],
  ["kafka", String.raw`kafka|rabbitmq|pub/?sub|message queue`, "arch"],
  // frontend
  ["react", String.raw`react(\.?js)?(?! native)|redux|next\.?js`, "frontend"], ["angular", String.raw`angular(js)?`, "frontend"], ["vue", String.raw`vue(\.?js)?`, "frontend"],
  ["html_css", String.raw`html5?|css3?|tailwind|sass`, "frontend_base"],
  ["react_native", String.raw`react native`, "mobile"], ["android", String.raw`android`, "mobile"], ["ios", String.raw`\bios\b`, "mobile"], ["flutter", String.raw`flutter|dart`, "mobile"],
  // data
  ["sql", String.raw`\bsql\b|postgres(ql)?|mysql|oracle db|sql server|t-sql|pl/?sql|relational database`, "db_sql"],
  ["nosql", String.raw`nosql|mongodb|mongo|cassandra|dynamodb|redis|elasticsearch|couchbase`, "db_nosql"],
  ["spark", String.raw`spark|databricks|hadoop|hive`, "bigdata"], ["snowflake", String.raw`snowflake|bigquery|redshift|synapse`, "warehouse"],
  ["airflow", String.raw`airflow|\bdbt\b|azure data factory|\badf\b|informatica|etl`, "pipeline"],
  ["tableau", String.raw`tableau`, "bi"], ["powerbi", String.raw`power ?bi|\bdax\b`, "bi"], ["looker", String.raw`looker|qlik`, "bi"],
  ["excel", String.raw`excel|vba|spreadsheets?`, "office"],
  ["ml", String.raw`machine learning|scikit|xgboost|regression model|classification model`, "ml"], ["dl", String.raw`deep learning|pytorch|tensorflow|keras|neural network|cnn|transformer model`, "ml"],
  ["llm", String.raw`\bllms?\b|large language model|generative ai|gen ?ai|langchain|\brag\b|prompt engineering|openai`, "ml"], ["cv", String.raw`computer vision|opencv|image processing`, "ml"], ["nlp", String.raw`\bnlp\b|natural language processing`, "ml"],
  ["statistics", String.raw`statistic(s|al)|hypothesis testing|a/b test`, "analytics"],
  // cloud / ops
  ["aws", String.raw`\baws\b|amazon web services|ec2|lambda|s3\b`, "cloud"], ["azure", String.raw`\bazure\b`, "cloud"], ["gcp", String.raw`\bgcp\b|google cloud`, "cloud"],
  ["docker", String.raw`docker|container(s|isation|ization)?`, "devops"], ["kubernetes", String.raw`kubernetes|\bk8s\b|helm|openshift`, "devops"],
  ["terraform", String.raw`terraform|cloudformation|ansible|infrastructure as code|\biac\b`, "devops"], ["cicd", String.raw`ci/?cd|jenkins|github actions|gitlab ci|azure devops`, "devops"],
  ["linux", String.raw`linux|unix|shell scripting|bash`, "sysadmin"], ["networking", String.raw`ccna|ccnp|routing|switching|tcp/?ip|bgp|ospf|firewall`, "network"],
  ["itil", String.raw`\bitil\b|itsm|incident management|problem management`, "itsm"], ["servicenow", String.raw`servicenow|service now`, "itsm_tool"],
  ["selenium", String.raw`selenium|cypress|playwright|appium|testng|junit|pytest`, "testing"], ["manual_testing", String.raw`manual testing|test cases|functional testing|regression testing|uat`, "testing"],
  // enterprise apps
  ["sap_fico", String.raw`sap fi(co)?|sap fi/co|fico`, "sap"], ["sap_sd_mm", String.raw`sap (sd|mm|pp|ewm|scm|wm)`, "sap"], ["sap_bw", String.raw`sap bw|bw/4hana|\bbw\b`, "sap"], ["s4hana", String.raw`s/?4 ?hana|sap hana`, "sap"],
  ["salesforce", String.raw`salesforce|sfdc|sales cloud|service cloud|marketing cloud`, "salesforce"],
  ["oracle_apps", String.raw`oracle (fusion|ebs|erp|epm|hcm)|hyperion|netsuite`, "erp"], ["workday", String.raw`workday`, "hris"],
  ["crm_tools", String.raw`hubspot|zoho crm|dynamics 365|leadsquared|crm`, "crm"], ["marketing_automation", String.raw`marketo|eloqua|braze|clevertap|moengage|marketing automation|campaign management`, "martech"],
  // finance / banking / ops domain skills
  ["fpa", String.raw`fp&a|financial planning|budgeting|financial forecasting|variance analysis`, "finance"], ["accounting", String.raw`general ledger|month[- ]end close|reconciliation|accounts payable|accounts receivable|ifrs|gaap|journal entries`, "finance"],
  ["audit", String.raw`internal audit|statutory audit|sox|audit`, "finance"], ["tax", String.raw`\bgst\b|direct tax|indirect tax|transfer pricing|tds`, "finance"], ["ca", String.raw`chartered accountant|\bca\b(?= (qualified|inter|final|certification))|\bacca\b|\bcpa\b`, "qual_fin"], ["cfa", String.raw`\bcfa\b|\bfrm\b`, "qual_fin"],
  ["credit_underwriting", String.raw`underwriting|credit appraisal|credit assessment|credit analysis|cibil|sanction`, "lending"], ["loan_ops", String.raw`loan (processing|disbursal|disbursement|servicing|documentation)|disbursal|collateral|\botc\b|pdd`, "lending"],
  ["kyc_aml", String.raw`\bkyc\b|\baml\b|anti[- ]money|customer due diligence|transaction monitoring|sanctions screening`, "fincrime"], ["capital_markets", String.raw`capital markets|trade settlement|settlements?|custody|corporate actions|fund accounting|\bnav\b|derivatives|securities`, "capmkt"],
  ["insurance", String.raw`insurance|claims (processing|adjudication)|policy servicing|underwriter`, "insurance"], ["payments", String.raw`payments?|\bupi\b|cards|chargebacks?|merchant`, "payments"],
  ["supply_chain", String.raw`supply chain|demand planning|inventory|logistics|warehouse|procurement|sourcing|vendor management`, "scm"],
  ["category_mgmt", String.raw`category management|category manager|assortment|\bgmv\b|merchandising|p&l|business head`, "biz"],
  ["sales_b2b", String.raw`b2b sales|enterprise sales|new business|business development|lead generation|pipeline|quota|key accounts?|account management`, "sales"],
  ["customer_service", String.raw`customer service|customer support|call cent(er|re)|voice process|chat support|csat`, "cs"],
  ["recruiting", String.raw`recruit(ment|ing)|talent acquisition|sourcing candidates|ats`, "hr"], ["payroll", String.raw`payroll`, "hr"],
  ["product_mgmt", String.raw`product management|product roadmap|prd|product strategy|user stories|backlog`, "product"], ["agile", String.raw`agile|scrum|jira|kanban`, "pm"],
  ["project_mgmt", String.raw`project management|pmp|prince2|stakeholder management|project plan`, "pm"],
  ["seo_sem", String.raw`\bseo\b|\bsem\b|google ads|meta ads|performance marketing|ppc`, "marketing"],
  ["embedded", String.raw`embedded|firmware|rtos|microcontroller|autosar`, "embedded"], ["verilog", String.raw`verilog|systemverilog|\buvm\b|\brtl\b|vhdl`, "vlsi"],
];
export const SKILLS: Skill[] = S.map(([id, src, family]) => ({ id, re: new RegExp(`(?<![a-z0-9])(?:${src})(?![a-z0-9])`, "i"), family }));
const BY_ID = new Map(SKILLS.map((s) => [s.id, s]));
/** How far having `have` covers a need for `need`, 0–1: the same skill 1; stated close cousins their weight; otherwise 0. */
const NEAR: Record<string, Record<string, number>> = {
  react: { angular: 0.5, vue: 0.6, react_native: 0.5 }, angular: { react: 0.5, vue: 0.5 }, vue: { react: 0.6, angular: 0.5 },
  javascript: { typescript: 0.8, nodejs: 0.4 }, typescript: { javascript: 0.9 }, nodejs: { javascript: 0.6, typescript: 0.4 },
  java: { kotlin: 0.5, spring: 0.4, scala: 0.3 }, spring: { java: 0.7 }, kotlin: { java: 0.5 }, fastapi: { python: 0.7 }, python: { fastapi: 0.5 },
  aws: { azure: 0.5, gcp: 0.5 }, azure: { aws: 0.5, gcp: 0.5 }, gcp: { aws: 0.5, azure: 0.5 },
  tableau: { powerbi: 0.7, looker: 0.7 }, powerbi: { tableau: 0.7, looker: 0.7 }, looker: { tableau: 0.7, powerbi: 0.7 },
  spark: { snowflake: 0.4 }, snowflake: { spark: 0.4 }, sql: { snowflake: 0.4 }, docker: { kubernetes: 0.4 }, kubernetes: { docker: 0.6 },
  ml: { dl: 0.5, statistics: 0.5 }, dl: { ml: 0.7, cv: 0.4, nlp: 0.4, llm: 0.4 }, llm: { nlp: 0.6, dl: 0.4 }, nlp: { llm: 0.5 },
  sap_fico: { s4hana: 0.4 }, sap_sd_mm: { s4hana: 0.4 }, sap_bw: { s4hana: 0.3 }, s4hana: { sap_fico: 0.3, sap_sd_mm: 0.3 },
  credit_underwriting: { loan_ops: 0.4 }, loan_ops: { credit_underwriting: 0.3 }, selenium: { manual_testing: 0.6 }, manual_testing: { selenium: 0.2 },
  crm_tools: { salesforce: 0.3 }, salesforce: { crm_tools: 0.6 },
};
export function cover(have: string, need: string): number { return have === need ? 1 : NEAR[have]?.[need] ?? 0; }
export function skillsIn(text: string): Set<string> { const out = new Set<string>(); for (const s of SKILLS) if (s.re.test(text)) out.add(s.id); return out; }
export const skillFamily = (id: string) => BY_ID.get(id)?.family ?? "";
