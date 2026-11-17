const { Client } = require("@notionhq/client");
const {
  requireUser,
  unauthorized,
  users,
  recordActivityDay,
  loginStreak,
  activityStreak,
} = require("./auth");

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const DB_IDS = {
  actions: "9ad685dca6294a8e8978f1314d0b1ada",
  governance: "0a17cd5ae06b44f49a0b71df06c3e71e",
  bugs: "752c1cbb11534520a47b7411e0ba9e57",
  risks: "32cc7c4edba04b15a9639fabbb9ee4f5",
  decisions: "216c56074fcb42d5b2b0ace5f606e1a0",
  learnings: "29360bfb014e80d68dc7fdd8ceb21875",
  milestones: "30560bfb014e80568a6dd1d280d91c88",
  pipeline: "9c9aa106c37b4aab9276199a37773dba",
  boulders: "fec81333ee4a4414b80662029c6d22f8",
};

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

const response = (statusCode, body) => ({
  statusCode,
  headers,
  body: JSON.stringify(body),
});

const normaliseId = (value) =>
  String(value || "")
    .replace(/-/g, "")
    .toLowerCase();

async function queryAll(databaseId, filter, sorts, pageSize = 100) {
  const results = [];
  let startCursor;

  do {
    const page = await notion.databases.query({
      database_id: databaseId,
      filter: filter || undefined,
      sorts: sorts || undefined,
      page_size: Math.min(Math.max(Number(pageSize) || 100, 1), 100),
      start_cursor: startCursor || undefined,
    });

    if(databaseId===DB_IDS.risks) {
      for(const row of page.results){
        const prop=propertyEntry(row.properties,["Linked Controls"])?.value;
        if(prop?.has_more) await expandRelations(row,prop);
      }
    }
    results.push(...page.results);
    startCursor = page.has_more ? page.next_cursor : undefined;
  } while (startCursor);

  return {
    object: "list",
    results,
    has_more: false,
    next_cursor: null,
  };
}

async function getDatabaseSchema(databaseId) {
  const database = await notion.databases.retrieve({ database_id: databaseId });
  const properties = Object.create(null);

  Object.entries(database.properties || {}).forEach(([name, property]) => {
    const configuration = property[property.type] || {};
    const options = Array.isArray(configuration.options)
      ? configuration.options.map((option) => option.name).filter(Boolean)
      : [];

    properties[name] = {
      id: property.id,
      type: property.type,
      ...(property.type === "number" && {format: configuration.format}),
      ...(property.type === "relation" && {relatedDatabase: configuration.database_id}),
      ...(property.description && {description: property.description}),
      options,
    };
  });

  return {
    id: database.id,
    properties,
  };
}

function propertyEntry(properties, names) {
  const entries = Object.entries(properties || {});
  for (const wanted of names) {
    const match = entries.find(
      ([name]) => name.trim().toLowerCase() === wanted.trim().toLowerCase(),
    );
    if (match) return { name: match[0], value: match[1] };
  }
  return null;
}

function actionProgress(properties) {
  const value = propertyEntry(properties, ["% complete"])?.value;
  if (!value || value.type !== "number" || value.number == null) {
    return { percent: null, progressError: null };
  }
  const percent = value.number;
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    return {
      percent: null,
      progressError: "Progress must be between 0 and 100.",
    };
  }
  return { percent, progressError: null };
}

async function completePage(pageId, requestedCompletionDate, includePage = false) {
  const page = await notion.pages.retrieve({ page_id: pageId });
  const databaseId = normaliseId(page.parent && page.parent.database_id);
  const actionsId = normaliseId(DB_IDS.actions);
  const governanceId = normaliseId(DB_IDS.governance);
  const bugsId = normaliseId(DB_IDS.bugs);

  if (![actionsId, governanceId, bugsId].includes(databaseId)) {
    const error = new Error("This page is not in an approved action database.");
    error.statusCode = 403;
    throw error;
  }

  const statusProperty = page.properties && page.properties.Status;
  if (!statusProperty || !["select", "status"].includes(statusProperty.type)) {
    const error = new Error(
      "The Notion page does not have an editable Status property.",
    );
    error.statusCode = 400;
    throw error;
  }

  const completionStatus = databaseId === bugsId ? "Resolved" : "Done";
  if (
    requestedCompletionDate &&
    !/^\d{4}-\d{2}-\d{2}$/.test(String(requestedCompletionDate))
  ) {
    const error = new Error("completion_date must use YYYY-MM-DD format.");
    error.statusCode = 400;
    throw error;
  }
  const completionDate =
    requestedCompletionDate || new Date().toISOString().slice(0, 10);
  const completionDateCandidates =
    databaseId === bugsId
      ? ["Date Resolved"]
      : ["Completion Date", "Completed Date"];
  const completionDateField = propertyEntry(
    page.properties,
    completionDateCandidates,
  );
  const completionDateProperty =
    completionDateField?.value.type === "date"
      ? completionDateField.name
      : null;
  const properties = {
    Status:
      statusProperty.type === "status"
        ? { status: { name: completionStatus } }
        : { select: { name: completionStatus } },
  };

  if (completionDateProperty) {
    properties[completionDateProperty] = {
      date: { start: completionDate },
    };
  }

  if ([actionsId,governanceId].includes(databaseId)) {
    const percent = propertyEntry(page.properties, ["% complete"]);
    if (percent?.value.type === "number")
      properties[percent.name] = { number: 100 };
  }

  const alreadyDone = statusProperty[statusProperty.type]?.name === completionStatus;
  const linkedBoulders = databaseId === actionsId ? personalFields(page.properties).boulders : [];
  const frequency = propertyEntry(page.properties, ["Frequency"])?.value.select?.name;
  let nextPage;
  if(databaseId === governanceId && !alreadyDone && frequency && frequency !== "One-off"){
    nextPage = await nextGovernancePage(page,completionDate,frequency);
  }
  const updated = alreadyDone ? page : await notion.pages.update({
    page_id: pageId,
    properties,
  });

  return {
    ok: true,
    id: updated.id,
    url: updated.url,
    ...(includePage ? {page:updated} : {}),
    didComplete: !alreadyDone,
    linkedBoulders: alreadyDone ? [] : linkedBoulders,
    ...(nextPage && {nextPage}),
  };
}

async function reschedulePage(pageId, dueDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dueDate || ""))) {
    const error = new Error("due_date must use YYYY-MM-DD format.");
    error.statusCode = 400;
    throw error;
  }

  const page = await notion.pages.retrieve({ page_id: pageId });
  const databaseId = normaliseId(page.parent && page.parent.database_id);
  const approvedIds = [DB_IDS.actions, DB_IDS.governance].map(normaliseId);

  if (!approvedIds.includes(databaseId)) {
    const error = new Error(
      "This page is not in an approved calendar database.",
    );
    error.statusCode = 403;
    throw error;
  }

  const dueDateName = ["Due Date", "Due"].find(
    (name) => page.properties?.[name]?.type === "date",
  );
  if (!dueDateName) {
    const error = new Error(
      "The Notion page does not have an editable Due Date property.",
    );
    error.statusCode = 400;
    throw error;
  }

  const updated = await notion.pages.update({
    page_id: pageId,
    properties: {
      [dueDateName]: { date: { start: dueDate } },
    },
  });

  return { ok: true, id: updated.id, url: updated.url, due_date: dueDate };
}

const mySources = {
  actions: ["Operations action", ["Owner", "Assigned to"], ["Due Date", "Due"]],
  governance: ["Governance action", ["Owner"], ["Due Date"]],
  risks: ["Risk review", ["Risk Owner", "Owner"], ["Review Date"]],
  bugs: ["Bug", ["Assigned to", "Assignee", "Owner"], ["Due Date", "Due"]],
};
const norm = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

function ownsWork(page, key, account) {
  const properties = page.properties || {};
  const property = mySources[key][1]
    .map((name) => properties[name])
    .find(Boolean);
  if (key === "bugs") {
    const sam = ["sam","samuel","sam mounsey","samuel mounsey"];
    return [account.name,...(Array.isArray(account.ops_owner_labels) ? account.ops_owner_labels : [])].some(name=>sam.includes(norm(name)));
  }
  if (!property) return false;

  const ownerLabels = Array.isArray(account.ops_owner_labels)
    ? account.ops_owner_labels.map(norm)
    : [];
  const labels = new Set([norm(account.email), ...ownerLabels].filter(Boolean));
  if (property.type === "people") {
    return (property.people || []).some(
      (person) =>
        (person.person?.email &&
          norm(person.person.email) === norm(account.email)) ||
        (person.id &&
          account.notion_user_id &&
          normaliseId(person.id) === normaliseId(account.notion_user_id)),
    );
  }

  const values =
    property.type === "select"
      ? [property.select?.name]
      : property.type === "multi_select"
        ? (property.multi_select || []).map((option) => option.name)
        : property.type === "rich_text"
          ? [(property.rich_text || []).map((text) => text.plain_text).join("")]
          : [];
  return values
    .flatMap((value) => String(value || "").split(/[,;]/))
    .some((value) => labels.has(norm(value)));
}

function myItem(page, key) {
  const properties = page.properties || {};
  const title = Object.values(properties).find(
    (value) => value.type === "title",
  );
  const statusProperty = properties["Risk Category"] || properties.Status;
  const status =
    statusProperty?.status?.name || statusProperty?.select?.name || "";
  const blocked =
    Boolean(propertyEntry(properties, ["Blocked?", "Blocked"])?.value.checkbox) ||
    (key === "governance" && status === "Overdue");

  return {
    id: page.id,
    url: page.url,
    ...(["actions","governance"].includes(key)
      ? actionProgress(properties)
      : { percent: null, progressError: null }),
    ...personalFields(properties),
    source: mySources[key][0],
    title: title?.title?.map((text) => text.plain_text).join("") || "Untitled",
    due:
      mySources[key][2]
        .map((name) => properties[name]?.date?.start)
        .find(Boolean) || null,
    status,
    blocked,
  };
}

async function personal(session) {
  const account = await (
    await users()
  ).findOne(
    { email: session.email },
    {
      projection: { email: 1, name: 1, notion_user_id: 1, ops_owner_labels: 1 },
    },
  );
  if (!account || String(account._id) !== session.sub) return unauthorized();

  const sourceKeys = Object.keys(mySources);
  const results = await Promise.allSettled(
    sourceKeys.map(async (key) =>
      (await queryAll(DB_IDS[key])).results
        .filter((page) => ownsWork(page, key, account))
        .map((page) => myItem(page, key)),
    ),
  );
  const unavailable = sourceKeys
    .filter((_, index) => results[index].status === "rejected")
    .map((key) => mySources[key][0]);
  const items = results
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .sort((left, right) =>
      (left.due || "9999").localeCompare(right.due || "9999"),
    );

  return response(200, {
    name: account.name || account.email,
    items,
    unavailable,
    canManageLeave: true,
    loginStreak: session.loginStreak,
    activityStreak: session.activityStreak,
  });
}

async function teamLeaderboard(session) {
  const members = await (
    await users()
  )
    .find(
      { active: { $ne: false } },
      {
        projection: {
          name: 1,
          roles: 1,
          ops_login_days: 1,
          ops_activity_days: 1,
          ops_streak_leave: 1,
        },
      },
    )
    .toArray();
  const site = String(process.env.SITE_KEY || "ops").toLowerCase();
  const items = members
    .filter((user) => {
      const roles = Array.isArray(user.roles)
        ? user.roles.map((role) => String(role).toLowerCase())
        : [];
      return roles.includes(site) || roles.includes("admin");
    })
    .map((user) => ({
      id: String(user._id),
      name: user.name || "Team member",
      you: String(user._id) === session.sub,
      login: loginStreak(user.ops_login_days, undefined, user.ops_streak_leave)
        .current,
      activity: activityStreak(user.ops_activity_days, user.ops_streak_leave)
        .activeToday,
    }))
    .sort(
      (left, right) =>
        right.login - left.login ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    );

  let rank = 0;
  let previous = null;
  items.forEach((row, index) => {
    if (row.login !== previous) rank = index + 1;
    previous = row.login;
    row.rank = rank;
  });
  return response(200, { items });
}

const registerRequired = {
  actions: ["Owner","Function","Vertical","Due Date","Urgency","Type","Start Date","Status"],
  governance: ["Owner","Function","Due Date","Start Date","Frequency","Urgency","Status","Type","Linked Controls","Linked Risks","Source Workflow"],
  bugs: ["Module / Feature","Priority","Type","Vertical","Reported By","Start Date","Due Date","Date Logged","Status"]
};
function missingRegisterFields(db, schema, values) {
  const required = new Set((registerRequired[db] || []).map(name=>name.toLowerCase()));
  const blocked = Object.entries(values).some(([k,v])=>k.trim().toLowerCase()==="blocked?" && v===true);
  if (blocked && ["actions","governance"].includes(db)) required.add(db==="actions"?"blocker notes":"blocked notes");
  return Object.keys(schema).filter(name=>{
    if (!required.has(name.trim().toLowerCase()) && schema[name].type!=="title") return false;
    const v=values[name];
    return v==null || typeof v==="string"&&!v.trim() || Array.isArray(v)&&!v.length || schema[name].type==="date"&&!v.start;
  });
}
function reviewNextDate(day, frequency) {
  const months={monthly:1,quarterly:3,quartely:3,annually:12,annual:12,yearly:12}[String(frequency||"").toLowerCase()];
  if(!months || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const original=new Date(day+"T12:00:00Z");
  if(!Number.isFinite(original.getTime()) || original.toISOString().slice(0,10)!==day) return null;
  const target=new Date(Date.UTC(original.getUTCFullYear(),original.getUTCMonth()+months+1,0,12));
  target.setUTCDate(Math.min(target.getUTCDate(),original.getUTCDate()));
  return target.toISOString().slice(0,10);
}
function riskScoreAtCheck(property) {
  const p = property?.type === "formula" ? property.formula : property;
  const value = p?.type === "number" ? p.number : p?.type === "string" ? p.string : null;
  if (value == null || (typeof value === "string" && !value.trim())) return null;
  const score = Number(value);
  return Number.isFinite(score) ? score : null;
}
function monitoringCheckName(properties, due) {
  const field = Object.values(properties).find(p => p.type === "title");
  const name = field?.title?.map(t => t.plain_text).join("").trim() || "Untitled risk";
  return "Risk review · " + Array.from(name).slice(0, 900).join("") + " · due " + due;
}

function personalFields(p) {
  const pick=(...names)=>propertyEntry(p,names)?.value;
  const choice=x=>x?.select?.name||x?.status?.name||"";
  const vertical=pick("Vertical");
  const relation=Object.entries(p).find(([name,v])=>v.type==="relation" && /boulders?/i.test(name))?.[1];
  return {type:choice(pick("Type")),urgency:choice(pick("Urgency","Priority")),fn:choice(pick("Function","Domain")),
    vertical:vertical?.multi_select?.map(o=>o.name)||[choice(vertical)].filter(Boolean),
    boulders:(relation?.relation||[]).map(x=>x.id)};
}
async function expandRelations(page,prop){
  const records=[];
  let cursor;
  do{
    const data=await notion.pages.properties.retrieve({page_id:page.id,property_id:prop.id,...(cursor && {start_cursor:cursor})});
    if(!Array.isArray(data.results))boardError("Notion could not return all linked records.");
    records.push(...data.results.map(row=>row.relation));
    cursor=data.has_more?data.next_cursor:null;
  }while(cursor);
  prop.relation=records;prop.has_more=false;
}
function zurichDay(){return new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Zurich",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());}
async function runOccurrence(key, perform){
  const accounts=await users();
  const journal=accounts.client.db(accounts.dbName).collection("ops_occurrences");
  const completed=await journal.findOne({_id:key});
  if(completed?.result)return completed.result;
  const token=require("crypto").randomUUID(),now=new Date();
  try{
    await journal.updateOne({_id:key,result:{$exists:false},$or:[{lease:{$exists:false}},{lease:{$lt:now}}]},
      {$set:{token,lease:new Date(now.getTime()+180000)}},{upsert:true});
  }catch(e){if(e.code===11000)boardError("This occurrence is being saved. Refresh before retrying.",409);throw e;}
  const row=await journal.findOne({_id:key,token});
  if(!row) boardError("This occurrence is being saved.",409);
  const save=async data=>{
    const updated=await journal.updateOne({_id:key,token},{$set:data});
    if(!updated.matchedCount) boardError("This occurrence is being saved in another session.",409);
  };
  try{
    const result=await perform(row,save);
    await save({result});return result;
  }finally{await journal.updateOne({_id:key,token},{$unset:{token:"",lease:""}});}
}
function occurrenceProps(page){
  const props=Object.create(null);
  for(const [name,p] of Object.entries(page.properties||{})){
    const value=p[p.type];
    if(value==null) continue;
    if(p.type==="title")props[name]={title:value.map(t=>({text:{content:t.plain_text}}))};
    if(["Frequency","Function","Urgency","Type","Status"].includes(name.trim()) && ["select","status"].includes(p.type)){
      props[name]={[p.type]:{name:name.trim()==="Status"?"Inbox":value.name}};
    }
    if(["people","relation"].includes(p.type)){
      if(p.has_more)boardError("Open the activity in Notion to schedule an occurrence with this many owners or links.");
      props[name]={[p.type]:value.map(v=>({id:v.id}))};
    }
  }
  return props;
}
async function nextGovernancePage(page,day,frequency){
  if(!reviewNextDate(day,frequency))boardError("This frequency needs a manually scheduled next occurrence.");
  const result=await runOccurrence("governance:"+normaliseId(page.id),async(row,save)=>{
    const next=row.nextDue||reviewNextDate(day,frequency);
    const props=occurrenceProps(page),title=Object.keys(props).find(n=>props[n].title);
    const name=props[title]?.title.map(v=>v.text.content).join("");
    if(!name)boardError("Give the activity a title before scheduling its next occurrence.");
    props["Due Date"]={date:{start:next}};
    if(page.properties["Start Date"]?.date) {
      const previousDue=Date.parse(page.properties["Due Date"]?.date?.start?.slice(0,10));
      const previousStart=Date.parse(page.properties["Start Date"].date.start.slice(0,10));
      const span=Number.isFinite(previousDue-previousStart)?Math.max(0,previousDue-previousStart):0;
      props["Start Date"]={date:{start:new Date(Date.parse(next)-span).toISOString().slice(0,10)}};
    }
    // A backlink identifies this particular series if a create response is interrupted.
    if(row.creating){
      const candidates=await queryAll(DB_IDS.governance,{and:[{property:title,title:{equals:name}},{property:"Due Date",date:{equals:next}}]});
      for(const p of candidates.results){
        const blocks=await notion.blocks.children.list({block_id:p.id,page_size:100});
        if(blocks.results.some(b=>b.bookmark?.url===page.url))return {id:p.id};
      }
      if(Date.now()-new Date(row.creating).getTime()<120000)boardError("The new occurrence is being confirmed. Refresh before retrying.",409);
    }
    await save({nextDue:next,creating:new Date()});
    const created=await notion.pages.create({parent:{database_id:DB_IDS.governance},properties:props,
      children:[{object:"block",type:"bookmark",bookmark:{url:page.url}}]});
    return {id:created.id};
  });
  return notion.pages.retrieve({page_id:result.id});
}
// Use the same Notion database and optional override as the Compliance dashboard.
const monitoringDatabase = process.env.SAFEGUARDING_MONITORING_DB_ID || "41860bfb-014e-81a0-ac15-f7092aa70e8a";

async function logRiskCheck(pageId, snapshot, row, save) {
  if (row.monitoringLogId) return row.monitoringLogId;
  if (row.logCreateStartedAt) {
    // Notion may have accepted the create even when the response was lost.
    const found = await notion.databases.query({
      database_id: snapshot.logDatabase,
      filter: {and: [
        {property: "Related Risk", relation: {contains: pageId}},
        {property: "Check Date", date: {equals: snapshot.reviewDay}},
        {property: "Check", title: {equals: snapshot.checkName}}
      ]},
      page_size: 1
    });
    if (found.results.length) {
      const logId = found.results[0].id;
      await save({monitoringLogId: logId});
      return logId;
    }
    if (Date.now() - new Date(row.logCreateStartedAt).getTime() < 120000)
      boardError("The Monitoring Log is confirming the entry. Refresh before retrying.",409);
  }
  await save({...snapshot, logCreateStartedAt: new Date()});
  let entry;
  try {
    entry = await notion.pages.create({
      parent: {database_id: snapshot.logDatabase},
      properties: {
        Check: {title: [{text: {content: snapshot.checkName}}]},
        "Related Risk": {relation: [{id: pageId}]},
        "Check Date": {date: {start: snapshot.reviewDay}},
        "Carried Out?": {select: {name: "Yes"}},
        "Risk Score at Check": {number: snapshot.scoreAtReview}
      }
    });
  } catch (error) {
    if ([400,401,403,404,429].includes(error.status)) await save({logCreateStartedAt: null});
    throw error;
  }
  await save({monitoringLogId: entry.id});
  return entry.id;
}
function boulderCompletion(schema,props,percent){
  if(percent!==100)return;
  const s=propertyEntry(schema,["Status"]);
  if(!s || !["status","select"].includes(s.value.type) || !s.value.options.includes("Completed"))boardError("Boulders needs the Completed status in Notion.");
  props[s.name]={[s.value.type]:{name:"Completed"}};
}
async function finishRiskReview(body){
  if(body.db!=="risks" || !boardUuid.test(body.page_id) || !boardDate(body.expected_due) || body.expected_due.length!==10)boardError("Select a dated risk review.");
  const page_id=body.page_id, expected=body.expected_due;
  async function getRisk(){
    const page=await notion.pages.retrieve({page_id});
    if(normaliseId(page.parent?.database_id)!==normaliseId(DB_IDS.risks) || page.archived || page.in_trash)boardError("This risk is unavailable.",403);
    return page;
  }
  await getRisk();
  const result=await runOccurrence("risk:"+normaliseId(page_id)+":"+expected,async(row,save)=>{
    const risk=await getRisk(),p=risk.properties;
    const due=propertyEntry(p,["Review Date"]),day=row.reviewDay||zurichDay();
    const frequency=propertyEntry(p,["Review Frequency"])?.value.select?.name;
    if(!due || due.value.type!=="date")boardError("Review Date is unavailable.");
    const current=due.value.date?.start?.slice(0,10);
    const advanced=!!row.nextDue && current===row.nextDue;
    if(!advanced && current!==expected)boardError("Review Date has changed. Refresh the risk before completing it.",409);
    if(!advanced && ["closed","addressed"].includes(norm(propertyEntry(p,["Risk Category"])?.value?.select?.name)))boardError("This risk is closed.");
    const nextDue=row.nextDue||reviewNextDate(day,frequency);
    if(!nextDue)boardError("Choose a recurring Review Frequency in the Risk Register first.");
    if(nextDue<=expected)boardError("This next review is already scheduled for "+expected+".");
    const snapshot={
      reviewDay:day, nextDue,
      scoreAtReview:Object.hasOwn(row,"scoreAtReview") ? row.scoreAtReview : riskScoreAtCheck(propertyEntry(p,["Risk Score"])?.value),
      checkName:row.checkName || monitoringCheckName(p,expected),
      logDatabase:row.logDatabase || monitoringDatabase
    };
    const monitoringLogId=await logRiskCheck(risk.id,snapshot,row,save);
    if(!advanced){
      const latest=await getRisk();
      const latestDate=propertyEntry(latest.properties,["Review Date"])?.value.date?.start?.slice(0,10);
      if(latestDate!==expected && latestDate!==nextDue)
        boardError("The review was logged, but its Review Date changed. Refresh the risk to see its current schedule.",409);
      if(latestDate===expected)await notion.pages.update({page_id,properties:{[due.name]:{date:{start:nextDue}}}});
    }
    return {nextDue,monitoringLogId};
  });
  return {...result,page:await getRisk()};
}

const boardUuid = /^(?:[0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;

async function boardFieldOptions({db, field, cursor}) {
  if (!boardDatabases.has(db)) boardError("Unknown register.", 403);
  if (cursor != null && (typeof cursor !== "string" || !cursor.length || cursor.length > 2048)) boardError("Invalid list position.");
  const {properties} = await getDatabaseSchema(DB_IDS[db]);
  const property = Object.hasOwn(properties, field) && properties[field];
  const paging = {page_size: 50, ...(cursor && {start_cursor: cursor})};
  let page, options;
  if (property?.type === "people") {
    page = await notion.users.list(paging);
    options = page.results.filter(u => u.type === "person" && u.name).map(u => ({id: u.id, name: u.name}));
  } else if (property?.type === "relation" && property.relatedDatabase) {
    // Only the target configured by Notion for this field can be browsed.
    page = await notion.databases.query({database_id: property.relatedDatabase, ...paging});
    options = page.results.map(row => {
      const title = Object.values(row.properties || {}).find(p => p.type === "title");
      return {id: row.id, name: title?.title.map(t => t.plain_text).join("") || "Untitled"};
    });
  } else {
    boardError("Choices are unavailable for this field.");
  }
  return {options, next_cursor: page.has_more ? page.next_cursor : null};
}

function boardDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().startsWith(value);
}

async function boardProperty(name, property, value, db) {
  const {type, options} = property;
  const invalid = hint => boardError(name.trim() + " — " + hint);
  const array = () => {
    if (!Array.isArray(value) || value.length > 100 || new Set(value).size !== value.length) invalid("Choose up to 100 distinct entries.");
    return value;
  };
  function webLink(url, httpsOnly = false) {
    try {
      const parsed = new URL(url);
      return typeof url === "string" && url.length <= 2000 && (httpsOnly ? parsed.protocol === "https:" : ["https:", "http:"].includes(parsed.protocol));
    } catch { return false; }
  }
  switch (type) {
    case "title":
    case "rich_text": {
      if (typeof value !== "string" || (type === "title" && !value.trim()) || value.length > 100000) invalid("Enter valid text.");
      const points = Array.from(value);
      const result = [];
      for (let i = 0; i < points.length; i += 1000) result.push({text:{content: points.slice(i, i + 1000).join("")}});
      return {[type]:result};
    }
    case "number":
      if (!Number.isFinite(value)) invalid("Enter a number.");
      if (db === "boulders" && name === "Progress" && (value < 0 || value > 100)) invalid("Enter 0 to 100.");
      return {number:property.format === "percent" ? value / 100 : value};
    case "checkbox":
      if (typeof value !== "boolean") invalid("Choose yes or no.");
      return {checkbox:value};
    case "select":
    case "status":
      if (!options.includes(value)) invalid("Choose a current Notion option.");
      return {[type]:{name:value}};
    case "multi_select":
      return {multi_select:array().map(v => {
        if (!options.includes(v)) invalid("Choose a current Notion option.");
        return {name:v};
      })};
    case "date": {
      if (!boardDate(value?.start) || (value.end != null && (!boardDate(value.end) || value.end.length !== value.start.length || Date.parse(value.end) < Date.parse(value.start)))) invalid("Check the start and end dates.");
      return {date:{start:value.start, ...(value.end && {end:value.end})}};
    }
    case "people":
    case "relation": {
      const items = array();
      if (items.some(id => typeof id !== "string" || !boardUuid.test(id))) invalid("Choose a valid entry.");
      if (type === "relation") {
        for (const page_id of items) {
          const linked = await notion.pages.retrieve({page_id});
          if (!property.relatedDatabase || !linked.parent?.database_id || normaliseId(linked.parent.database_id) !== normaliseId(property.relatedDatabase) || linked.archived || linked.in_trash) invalid("Choose a page in the linked register.");
        }
      }
      return {[type]:items.map(id => ({id}))};
    }
    case "files":
      return {files:array().map(url => {
        if (!webLink(url, true)) invalid("Use an HTTPS file link.");
        const parsed = new URL(url);
        return {type:"external",name:parsed.pathname.split("/").pop()?.slice(0,200) || parsed.hostname,external:{url}};
      })};
    case "url":
      if (!webLink(value)) invalid("Enter a web address.");
      return {url:value};
    case "email":
    case "phone_number":
      if (typeof value !== "string" || !value.trim() || value.length > 2000) invalid("Enter a valid value.");
      return {[type]:value};
    default:
      invalid("Notion manages this field.");
  }
}

async function boardCreateProperties(schema, fields, db) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) boardError("Register fields are missing.");
  const title = Object.keys(schema).find(name => schema[name].type === "title");
  if (!title || !Object.hasOwn(fields, title)) boardError("Enter a title for the new page.");
  const missing=missingRegisterFields(db,schema,fields);
  if(missing.length) boardError("Please enter "+missing.join(", ")+".");
  const result = Object.create(null);
  for (const [name, value] of Object.entries(fields)) {
    if (!Object.hasOwn(schema, name)) boardError("The register fields have changed. Reopen the form to reload them.");
    result[name] = await boardProperty(name, schema[name], value, db);
  }
  return result;
}

const boardDatabases = new Set(["actions","governance","bugs","risks","boulders"]);
function boardError(message, statusCode = 400) { throw Object.assign(new Error(message), {statusCode}); }
async function writeBoardItem(body, session) {
  const {db, operation} = body;
  if (!boardDatabases.has(db)) boardError("This register cannot be edited here.",403);
  const creating = operation === "board-create", database_id = DB_IDS[db];
  let item;
  if (!creating) {
    if (typeof body.page_id !== "string" || !/^[a-f0-9-]{32,36}$/i.test(body.page_id)) boardError("Invalid record.");
    item = await notion.pages.retrieve({page_id:body.page_id});
    if (normaliseId(item.parent?.database_id) !== normaliseId(database_id) || item.archived || item.in_trash) boardError("This record is not editable in this register.",403);
  }
  const schema = (await getDatabaseSchema(database_id)).properties;
  if (creating && !Object.hasOwn(body,"fields")) {
    const title=Object.keys(schema).find(n=>schema[n].type==="title");
    const state=propertyEntry(schema,db==="risks"?["Risk Category","Status"]:["Status"]);
    body.fields={...(title && {[title]:body.title}),...(body.status!=null && state && {[state.name]:body.status}),...(body.percent!=null && db==="boulders" && {Progress:body.percent})};
  }
  if (creating) {
    if(db==="bugs"){
      if(schema["Date Logged"] && !body.fields?.["Date Logged"] && body.fields) body.fields["Date Logged"]={start:zurichDay()};
      if(schema.Status?.options.includes("Open") && body.fields && body.fields.Status==null)body.fields.Status="Open";
    }
    const properties = await boardCreateProperties(schema, body.fields, db);
    if(db==="boulders"){
      boulderCompletion(schema,properties,body.fields.Progress);
      if(body.fields.Status==="Completed" && body.fields.Progress!=null && body.fields.Progress<100)boardError("Choose an active status for progress below 100%.");
      if(body.fields.Status==="Completed" && schema.Progress?.type==="number")properties.Progress={number:1};
    }
    const status = propertyEntry(schema, ["Status"]);
    const closed = db === "bugs" ? "Resolved" : ["actions","governance"].includes(db) ? "Done" : null;
    const complete = !!closed && !!status && properties[status.name]?.[status.value.type]?.name === closed;
    if (complete) {
      const date = propertyEntry(schema, db === "bugs" ? ["Date Resolved"] : ["Completion Date","Completed Date"]);
      if (date?.value.type === "date" && !properties[date.name]) properties[date.name] = {date:{start:new Date().toISOString().slice(0,10)}};
      const pct = db !== "bugs" && propertyEntry(schema, ["% complete"]);
      if (pct?.value.type === "number") properties[pct.name] = {number:pct.value.format === "percent" ? 1 : 100};
    }
    if(db==="governance" && complete && body.fields.Frequency && body.fields.Frequency!=="One-off") boardError("Save the recurring activity open, then mark it Done to schedule the next occurrence.");
    const page = await notion.pages.create({parent:{database_id},properties});
    if (complete) {
      try { if (await recordActivityDay(session.email)) return {page}; } catch {}
      return {page,warning:"Page saved. Activity could not be recorded."};
    }
    return {page};
  }
  const state = propertyEntry(schema,db==="risks"?["Risk Category","Status"]:["Status"]);
  const props = {};
  if (body.status != null) {
    if (!state || !["select","status"].includes(state.value.type) || !state.value.options.includes(body.status)) boardError("Choose an existing Notion status.");
    const terminal = db==="bugs" ? "Resolved" : ["actions","governance"].includes(db) ? "Done" : null;
    if (body.status === terminal) {
      const result=await completePage(body.page_id,body.completion_date,true);
      let warning;
      if(result.didComplete) {try {if(!await recordActivityDay(session.email)) warning="Saved; activity could not be recorded.";} catch {warning="Saved; activity could not be recorded.";}}
      return {page:result.page,warning,linkedBoulders:result.linkedBoulders,nextPage:result.nextPage};
    }
    props[state.name]={[state.value.type]:{name:body.status}};
  }
  if (db==="boulders" && body.percent != null) {
    if (schema.Progress?.type !== "number" || typeof body.percent!=="number" || !Number.isFinite(body.percent) || body.percent<0 || body.percent>100) boardError("Progress must be a number from 0 to 100.");
    props.Progress={number:body.percent/100};
    boulderCompletion(schema,props,body.percent);
  }
  if(db==="boulders" && state){
    if(body.status==="Completed" && body.percent==null && schema.Progress?.type==="number")props.Progress={number:1};
    if(body.percent==null && item?.properties?.Progress?.number===1)boulderCompletion(schema,props,100);
    if(body.percent!=null && body.percent<100 && body.status==="Completed")boardError("Choose an active status for progress below 100%.");
  }
  if (!Object.keys(props).length) boardError("Nothing to save.");
  const page = await notion.pages.update({page_id:body.page_id,properties:props});
  return {page};
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  const session = await requireUser(event, process.env.SITE_KEY || "ops");
  if (!session) return unauthorized();

  if (event.httpMethod !== "POST")
    return response(405, { error: "Method not allowed." });
  try {
    const body = JSON.parse(event.body || "{}");
    if (body.operation === "leaderboard") return await teamLeaderboard(session);
    if (!process.env.NOTION_TOKEN)
      return response(500, { error: "NOTION_TOKEN is not configured." });
    if (body.operation === "my-work") return await personal(session);

    if (body.operation === "review-risk") return response(200,await finishRiskReview(body));
    if (body.operation === "board-options") return response(200,await boardFieldOptions(body));
    if (["board-create","board-update"].includes(body.operation)) return response(200,await writeBoardItem(body,session));
    if (body.operation === "schema") {
      if (!body.db || !DB_IDS[body.db]) {
        return response(400, {
          error: `Unknown database: ${body.db || "missing"}`,
        });
      }

      return response(200, await getDatabaseSchema(DB_IDS[body.db]));
    }

    if (body.operation === "complete") {
      if (!body.page_id) {
        return response(400, { error: "Missing page_id." });
      }

      const result = await completePage(body.page_id, body.completion_date);
      if (result.didComplete && !(await recordActivityDay(session.email))) {
        result.activityWarning =
          "Task completed, but activity could not be recorded.";
      }
      delete result.didComplete;
      return response(200, result);
    }

    if (body.operation === "reschedule") {
      if (!body.page_id || !body.due_date) {
        return response(400, { error: "Missing page_id or due_date." });
      }

      return response(200, await reschedulePage(body.page_id, body.due_date));
    }

    if (!body.db || !DB_IDS[body.db]) {
      return response(400, {
        error: `Unknown database: ${body.db || "missing"}`,
      });
    }

    const data = await queryAll(
      DB_IDS[body.db],
      body.filter,
      body.sorts,
      body.page_size,
    );

    return response(200, data);
  } catch (error) {
    console.error("Notion API error:", error);
    return response(error.statusCode || 500, {
      error: error.message || "Notion request failed.",
    });
  }
};
