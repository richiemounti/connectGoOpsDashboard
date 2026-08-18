const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const DB_IDS = {
  actions: '9ad685dca6294a8e8978f1314d0b1ada',
  governance: '0a17cd5ae06b44f49a0b71df06c3e71e',
  bugs: '752c1cbb11534520a47b7411e0ba9e57',
  decisions: '216c56074fcb42d5b2b0ace5f606e1a0',
  learnings: '29360bfb014e80d68dc7fdd8ceb21875',
  milestones: '30560bfb014e80568a6dd1d280d91c88',
  pipeline: '9c9aa106c37b4aab9276199a37773dba',
  boulders: 'fec81333ee4a4414b80662029c6d22f8',
};

const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const response = (statusCode, body) => ({
  statusCode,
  headers,
  body: JSON.stringify(body),
});

const normaliseId = value => String(value || '').replace(/-/g, '').toLowerCase();

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
    object: 'list',
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
      ? configuration.options.map(option => option.name).filter(Boolean)
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

async function completePage(pageId) {
  const page = await notion.pages.retrieve({ page_id: pageId });
  const databaseId = normaliseId(page.parent && page.parent.database_id);
  const actionsId = normaliseId(DB_IDS.actions);
  const governanceId = normaliseId(DB_IDS.governance);
  const bugsId = normaliseId(DB_IDS.bugs);

  if (![actionsId, governanceId, bugsId].includes(databaseId)) {
    const error = new Error('This page is not in an approved action database.');
    error.statusCode = 403;
    throw error;
  }

  const statusProperty = page.properties && page.properties.Status;
  if (!statusProperty || !['select', 'status'].includes(statusProperty.type)) {
    const error = new Error('The Notion page does not have an editable Status property.');
    error.statusCode = 400;
    throw error;
  }

  const completionStatus = databaseId === bugsId ? 'Resolved' : 'Done';
  const completionDateProperty = databaseId === bugsId ? 'Date Resolved' : 'Completed Date';
  const properties = {
    Status: statusProperty.type === 'status'
      ? { status: { name: completionStatus } }
      : { select: { name: completionStatus } },
  };

  if (page.properties[completionDateProperty] && page.properties[completionDateProperty].type === 'date') {
    properties[completionDateProperty] = {
      date: { start: new Date().toISOString().slice(0, 10) },
    };
  }

  const updated = await notion.pages.update({
    page_id: pageId,
    properties,
  });

  return { ok: true, id: updated.id, url: updated.url };
}

async function reschedulePage(pageId, dueDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dueDate || ''))) {
    const error = new Error('due_date must use YYYY-MM-DD format.');
    error.statusCode = 400;
    throw error;
  }

  const page = await notion.pages.retrieve({ page_id: pageId });
  const databaseId = normaliseId(page.parent && page.parent.database_id);
  const approvedIds = [DB_IDS.actions, DB_IDS.governance].map(normaliseId);

  if (!approvedIds.includes(databaseId)) {
    const error = new Error('This page is not in an approved calendar database.');
    error.statusCode = 403;
    throw error;
  }

  const dueDateName = ['Due Date', 'Due'].find(name => page.properties?.[name]?.type === 'date');
  if (!dueDateName) {
    const error = new Error('The Notion page does not have an editable Due Date property.');
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

exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (!process.env.NOTION_TOKEN) {
    return response(500, { error: 'NOTION_TOKEN is not configured.' });
  }

  if (event.httpMethod !== 'POST') {
    return response(405, { error: 'Method not allowed.' });
  }

  try {
    const body = JSON.parse(event.body || '{}');

    if (body.operation === 'schema') {
      if (!body.db || !DB_IDS[body.db]) {
        return response(400, { error: `Unknown database: ${body.db || 'missing'}` });
      }

      return response(200, await getDatabaseSchema(DB_IDS[body.db]));
    }

    if (body.operation === 'complete') {
      if (!body.page_id) {
        return response(400, { error: 'Missing page_id.' });
      }

      return response(200, await completePage(body.page_id));
    }

    if (body.operation === 'reschedule') {
      if (!body.page_id || !body.due_date) {
        return response(400, { error: 'Missing page_id or due_date.' });
      }

      return response(200, await reschedulePage(body.page_id, body.due_date));
    }

    if (!body.db || !DB_IDS[body.db]) {
      return response(400, { error: `Unknown database: ${body.db || 'missing'}` });
    }

    const data = await queryAll(
      DB_IDS[body.db],
      body.filter,
      body.sorts,
      body.page_size,
    );

    return response(200, data);
  } catch (error) {
    console.error('Notion API error:', error);
    return response(error.statusCode || 500, {
      error: error.message || 'Notion request failed.',
    });
  }
};
