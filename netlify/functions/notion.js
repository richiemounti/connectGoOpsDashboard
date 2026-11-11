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
  const properties = {};

  Object.entries(database.properties || {}).forEach(([name, property]) => {
    const configuration = property[property.type] || {};
    const options = Array.isArray(configuration.options)
      ? configuration.options.map((option) => option.name).filter(Boolean)
      : [];

    properties[name] = {
      id: property.id,
      type: property.type,
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

async function completePage(pageId, requestedCompletionDate) {
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

  if (databaseId === actionsId) {
    const percent = propertyEntry(page.properties, ["% complete"]);
    if (percent?.value.type === "number")
      properties[percent.name] = { number: 100 };
  }

  const updated = await notion.pages.update({
    page_id: pageId,
    properties,
  });

  return {
    ok: true,
    id: updated.id,
    url: updated.url,
    didComplete: statusProperty[statusProperty.type]?.name !== completionStatus,
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
    Boolean((properties["Blocked?"] || properties.Blocked)?.checkbox) ||
    (key === "governance" && status === "Overdue");

  return {
    id: page.id,
    url: page.url,
    ...(key === "actions"
      ? actionProgress(properties)
      : { percent: null, progressError: null }),
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
      login: loginStreak(user.ops_login_days).current,
      activity: activityStreak(user.ops_activity_days).activeToday,
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
