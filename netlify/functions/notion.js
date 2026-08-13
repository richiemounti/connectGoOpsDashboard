const { Client } = require('@notionhq/client');

const notion = new Client({
  auth: process.env.NOTION_TOKEN,
});

const DB_IDS = {
  actions: '9ad685dca6294a8e8978f1314d0b1ada',
  governance: '0a17cd5ae06b44f49a0b71df06c3e71e',
  decisions: '216c56074fcb42d5b2b0ace5f606e1a0',
  learnings: '29360bfb014e80d68dc7fdd8ceb21875',
  milestones: '30560bfb014e80568a6dd1d280d91c88',
  pipeline: '9c9aa106c37b4aab9276199a37773dba',
  boulders: 'fec81333ee4a4414b80662029c6d22f8',
};

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const respond = (statusCode, body) => ({
  statusCode,
  headers: HEADERS,
  body: JSON.stringify(body),
});

const plainText = values =>
  values?.map(value => value.plain_text || '').join('') || '';

const getTitle = page => {
  const activity = page.properties?.Activity;

  if (activity?.title) {
    return plainText(activity.title);
  }

  const titleProperty = Object.values(page.properties || {}).find(
    property => property.type === 'title',
  );

  return plainText(titleProperty?.title);
};

const getSelect = (page, propertyName) => {
  const property = page.properties?.[propertyName];

  return (
    property?.select?.name ||
    property?.status?.name ||
    ''
  );
};

const getPeople = (page, propertyName) => {
  const property = page.properties?.[propertyName];

  if (property?.people?.length) {
    return property.people
      .map(person => person.name)
      .filter(Boolean);
  }

  const textValue = plainText(property?.rich_text);

  return textValue
    ? textValue
        .split(',')
        .map(name => name.trim())
        .filter(Boolean)
    : [];
};

const getDate = (page, propertyName) =>
  page.properties?.[propertyName]?.date?.start || null;

const getNumber = (page, propertyName) =>
  page.properties?.[propertyName]?.number ?? null;

const notionText = value => ({
  type: 'rich_text',
  rich_text: value
    ? [
        {
          type: 'text',
          text: {
            content: String(value),
          },
          plain_text: String(value),
        },
      ]
    : [],
});

const notionTitle = value => ({
  type: 'title',
  title: value
    ? [
        {
          type: 'text',
          text: {
            content: String(value),
          },
          plain_text: String(value),
        },
      ]
    : [],
});

const notionSelect = value => ({
  type: 'select',
  select: value ? { name: String(value) } : null,
});

const notionPeople = names => ({
  type: 'people',
  people: names.map(name => ({
    id: name,
    name,
    type: 'person',
    person: {},
  })),
});

const notionDate = value => ({
  type: 'date',
  date: value ? { start: value, end: null } : null,
});

const notionCheckbox = value => ({
  type: 'checkbox',
  checkbox: Boolean(value),
});

const notionMultiSelect = values => ({
  type: 'multi_select',
  multi_select: values
    .filter(Boolean)
    .map(value => ({ name: String(value) })),
});

const trackerStatusForActionRequest = requestedActionStatus => {
  if (requestedActionStatus === 'This Week') {
    return ['In Progress', 'Overdue'];
  }

  if (requestedActionStatus === 'Inbox') {
    return ['To Do'];
  }

  if (requestedActionStatus === 'Done') {
    return ['Done'];
  }

  return ['To Do', 'In Progress', 'Overdue', 'Done'];
};

const actionStatusForTrackerStatus = trackerStatus => {
  if (trackerStatus === 'Done') {
    return 'Done';
  }

  if (trackerStatus === 'To Do') {
    return 'Inbox';
  }

  return 'This Week';
};

const trackerPageAsAction = page => {
  const trackerStatus = getSelect(page, 'Status');
  const ownerNames = getPeople(page, 'Owner');
  const domain = getSelect(page, 'Domain');
  const priority = getSelect(page, 'Priority');
  const type = getSelect(page, 'Type');
  const activityId = getNumber(page, 'Activity ID');
  const dueDate = getDate(page, 'Due Date');
  const overdue = trackerStatus === 'Overdue';

  const notes = [
    'Source: Governance Tracker',
    activityId ? `Activity ID: ${activityId}` : '',
    type ? `Type: ${type}` : '',
    overdue ? 'Governance activity is overdue' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    object: 'page',
    id: `governance-${page.id}`,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    archived: page.archived || false,
    in_trash: page.in_trash || false,
    url: page.url,
    public_url: page.public_url || null,

    properties: {
      Task: notionTitle(getTitle(page)),
      Owner: notionPeople(ownerNames),
      'Due Date': notionDate(dueDate),
      'Blocked?': notionCheckbox(overdue),
      Function: notionSelect('Compliance'),
      Vertical: notionMultiSelect(
        domain ? [domain] : ['Governance'],
      ),
      Urgency: notionSelect(priority || 'Normal'),
      Status: notionSelect(
        actionStatusForTrackerStatus(trackerStatus),
      ),
      'Blocker Notes': notionText(notes),
      Source: notionSelect('Governance Tracker'),
    },
  };
};

async function queryAll(databaseId, options = {}) {
  const results = [];
  let cursor;

  do {
    const response = await notion.databases.query({
      database_id: databaseId,
      filter: options.filter || undefined,
      sorts: options.sorts || undefined,
      page_size: 100,
      start_cursor: cursor || undefined,
    });

    results.push(...response.results);
    cursor = response.has_more
      ? response.next_cursor
      : undefined;
  } while (cursor);

  return results;
}

const requestedActionStatus = filter =>
  filter?.property === 'Status'
    ? filter?.select?.equals || filter?.status?.equals || null
    : null;

const titleFromActionPage = page => {
  const titleProperty =
    page.properties?.Task ||
    page.properties?.Name ||
    page.properties?.Action;

  return plainText(titleProperty?.title);
};

const ownerFromActionPage = page => {
  const property =
    page.properties?.Owner ||
    page.properties?.['Assigned to'];

  if (property?.people?.length) {
    return property.people
      .map(person => person.name || '')
      .filter(Boolean)
      .sort()
      .join(',');
  }

  return plainText(property?.rich_text);
};

const dueDateFromActionPage = page =>
  page.properties?.['Due Date']?.date?.start ||
  page.properties?.Due?.date?.start ||
  '';

const deduplicationKey = page =>
  [
    titleFromActionPage(page),
    dueDateFromActionPage(page),
    ownerFromActionPage(page),
  ]
    .join('|')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const mergeWithoutDuplicates = (...groups) => {
  const merged = new Map();

  groups.flat().forEach(page => {
    const key = deduplicationKey(page);

    if (!key || key === '||') {
      merged.set(page.id, page);
      return;
    }

    /*
     * Existing Actions records take priority because they are
     * inserted before Governance Tracker records.
     */
    if (!merged.has(key)) {
      merged.set(key, page);
    }
  });

  return [...merged.values()];
};

async function queryActionsWithGovernance({
  filter,
  sorts,
  pageSize,
}) {
  /*
   * Keep the original Actions query exactly as requested by
   * the dashboard.
   */
  const actionsPromise = notion.databases.query({
    database_id: DB_IDS.actions,
    filter: filter || undefined,
    sorts: sorts || undefined,
    page_size: pageSize,
  });

  /*
   * Governance Tracker uses different status names, so it is
   * queried separately and filtered after normalization.
   */
  const governancePromise = queryAll(DB_IDS.governance, {
    sorts: [
      {
        property: 'Due Date',
        direction:
          requestedActionStatus(filter) === 'Done'
            ? 'descending'
            : 'ascending',
      },
    ],
  });

  const [actionsResponse, governancePages] =
    await Promise.all([
      actionsPromise,
      governancePromise,
    ]);

  const requestedStatus = requestedActionStatus(filter);
  const allowedTrackerStatuses =
    trackerStatusForActionRequest(requestedStatus);

  const governanceActions = governancePages
    .filter(page => {
      const status = getSelect(page, 'Status');

      return (
        status !== 'Skipped' &&
        allowedTrackerStatuses.includes(status)
      );
    })
    .map(trackerPageAsAction)
    .filter(page => titleFromActionPage(page));

  const results = mergeWithoutDuplicates(
    actionsResponse.results,
    governanceActions,
  );

  return {
    ...actionsResponse,
    results,
    /*
     * The current dashboard requests the first 100 Actions.
     * Governance records are merged into that response.
     */
    has_more: actionsResponse.has_more,
    next_cursor: actionsResponse.next_cursor,
    governance_count: governanceActions.length,
    sources: ['Actions', 'Governance Tracker'],
  };
}

exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: HEADERS,
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return respond(405, {
      error: 'Method not allowed. Use POST.',
    });
  }

  if (!process.env.NOTION_TOKEN) {
    return respond(500, {
      error:
        'NOTION_TOKEN is not configured in the Ops Dashboard Netlify project.',
    });
  }

  let request;

  try {
    request = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, {
      error: 'The request body must contain valid JSON.',
    });
  }

  const {
    db,
    filter,
    sorts,
    page_size: requestedPageSize,
  } = request;

  if (!db || !DB_IDS[db]) {
    return respond(400, {
      error: `Unknown database: ${db || 'not provided'}`,
      availableDatabases: Object.keys(DB_IDS),
    });
  }

  const pageSize = Math.min(
    Math.max(Number(requestedPageSize) || 100, 1),
    100,
  );

  try {
    const response =
      db === 'actions'
        ? await queryActionsWithGovernance({
            filter,
            sorts,
            pageSize,
          })
        : await notion.databases.query({
            database_id: DB_IDS[db],
            filter: filter || undefined,
            sorts: sorts || undefined,
            page_size: pageSize,
          });

    return respond(200, response);
  } catch (error) {
    console.error(
      `Notion query failed for "${db}":`,
      error,
    );

    const status =
      error?.status === 401 || error?.status === 403
        ? 403
        : error?.status === 404
          ? 404
          : 500;

    const message =
      status === 403
        ? `The Ops Dashboard's Notion integration does not have access to one of the required databases.`
        : status === 404
          ? `A required Notion database could not be found. Check its database ID and connection access.`
          : 'The Notion database query failed.';

    return respond(status, {
      error: message,
      details: error?.message || 'Unknown Notion API error',
    });
  }
};
