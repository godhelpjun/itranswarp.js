// article api

const
    _ = require('lodash'),
    api = require('../api'),
    db = require('../db'),
    cache = require('../cache'),
    helper = require('../helper'),
    constants = require('../constants'),
    search = require('../search/search');

const
    settingApi = require('./settingApi'),
    categoryApi = require('./categoryApi'),
    attachmentApi = require('./attachmentApi');

var
    User = db.user,
    Article = db.article,
    Category = db.category,
    Text = db.text,
    warp = db.warp,
    nextId = db.nextId;

function indexArticle(r) {
    process.nextTick(() => {
        search.engine.index({
            type: 'article',
            id: r.id,
            tags: r.tags,
            name: r.name,
            description: r.description,
            content: helper.html2text(helper.md2html(r.content)),
            created_at: r.publish_at,
            updated_at: r.updated_at,
            url: '/article/' + r.id,
            upvotes: 0
        });
    });
}

function unindexArticle(r) {
    process.nextTick(() => {
        search.engine.unindex({
            id: r.id
        });
    });
}

// get recent published articles:
async function getRecentArticles(max) {
    // where publish_at < ? order by publish_at desc limit ?
    return await Article.findAll({
        where: {
            publish_at: {
                $lt: Date.now()
            }
        },
        order: ['publish_at', 'DESC'],
        offset: 0,
        limit: max
    });
}

// get all articles (include unpublished):
async function getAllArticles(page) {
    var nums = await Article.findAll({
        attributes: [[db.fn('COUNT', db.col('id')), 'num']]
    });
    page.total = await Article.findNumber('count(id)');
    if (page.isEmpty) {
        return [];
    }
    return await Article.findAll({
        offset: page.offset,
        limit: page.limit,
        order: 'publish_at DESC'
    });
}

async function getArticles(page) {
    var now = Date.now();
    page.total = await Article.findNumber({
        select: 'count(id)',
        where: 'publish_at<?',
        params: [now]
    });
    if (page.isEmpty) {
        return [];
    }
    return await Article.findAll({
        offset: page.offset,
        limit: page.limit,
        order: 'publish_at DESC'
    });
}

async function getArticlesByCategory(categoryId, page) {
    var now = Date.now();
    page.total = await Article.findNumber({
        select: 'count(id)',
        where: 'publish_at<? and category_id=?',
        params: [now, categoryId]
    });
    if (page.isEmpty) {
        return [];
    }
    return await Article.findAll({
        where: {
            'publish_at': {
                $lt: now
            },
            'category_id': categoryId
        },
        order: 'publish_at DESC',
        offset: page.offset,
        limit: page.limit
    });
}

async function getArticle(id, includeContent) {
    var
        text,
        article = await Article.findById(id);
    if (article === null) {
        throw api.notFound('Article');
    }
    if (includeContent) {
        text = await Text.findById(article.content_id);
        if (text === null) {
            throw api.notFound('Text');
        }
        article.content = text.value;
    }
    return article;
}

function toRssDate(dt) {
    return new Date(dt).toGMTString();
}

async function getFeed(domain) {
    var
        i, text, article, url,
        articles = await getRecentArticles(20),
        last_publish_at = articles.length === 0 ? 0 : articles[0].publish_at,
        website = await settingApi.getWebsiteSettings(),
        rss = [],
        rss_footer = '</channel></rss>';
    rss.push('<?xml version="1.0"?>\n');
    rss.push('<rss version="2.0"><channel><title><![CDATA[');
    rss.push(website.name);
    rss.push(']]></title><link>http://');
    rss.push(domain);
    rss.push('/</link><description><![CDATA[');
    rss.push(website.description);
    rss.push(']]></description><lastBuildDate>');
    rss.push(toRssDate(last_publish_at));
    rss.push('</lastBuildDate><generator>iTranswarp.js</generator><ttl>3600</ttl>');

    if (articles.length === 0) {
        rss.push(rss_footer);
    }
    else {
        for (i=0; i<articles.length; i++) {
            article = articles[i];
            text = await Text.findById(article.content_id);
            url = 'http://' + domain + '/article/' + article.id;
            rss.push('<item><title><![CDATA[');
            rss.push(article.name);
            rss.push(']]></title><link>');
            rss.push(url);
            rss.push('</link><guid>');
            rss.push(url);
            rss.push('</guid><author><![CDATA[');
            rss.push(article.user_name);
            rss.push(']]></author><pubDate>');
            rss.push(toRssDate(article.publish_at));
            rss.push('</pubDate><description><![CDATA[');
            rss.push(helper.md2html(text.value, true));
            rss.push(']]></description></item>');
        }
        rss.push(rss_footer);
    }
    return rss.join('');
}

var RE_TIMESTAMP = /^\-?[0-9]{1,13}$/;

module.exports = {

    getRecentArticles: getRecentArticles,

    getArticlesByCategory: getArticlesByCategory,

    getAllArticles: getAllArticles,

    getArticles: getArticles,

    getArticle: getArticle,

    'GET /feed': async (ctx, next) => {
        var
            rss,
            host = ctx.request.host,
            response = ctx.response,
            gf = async () => {
                return await getFeed(host);
            };
        rss = await cache.get('cached_rss', gf);
        response.set('Cache-Control', 'max-age: 3600');
        response.type = 'text/xml';
        response.body = rss;
    },

    'GET /api/articles/:id': async function (ctx, next) {
        /**
         * Get article.
         * 
         * @name Get Article
         * @param {string} id: Id of the article.
         * @param {string} [format]: Return html if format is 'html', default to '' (raw).
         * @return {object} Article object.
         * @error {resource:notfound} Article was not found by id.
         */
        let
            id = ctx.request.params.id,
            article = await getArticle(id, true);
        if (article.publish_at > Date.now() && (this.request.user===null || this.request.user.role > constants.role.CONTRIBUTOR)) {
            throw api.notFound('Article');
        }
        if (ctx.request.query.format === 'html') {
            article.content = helper.md2html(article.content, true);
        }
        ctx.rest(article);
    },

    'GET /api/articles': async function (ctx, next) {
        /**
         * Get articles by page.
         * 
         * @name Get Articles
         * @param {number} [page=1]: The page number, starts from 1.
         * @return {object} Article objects and page information.
         */
        ctx.checkPermission(constants.role.CONTRIBUTOR);
        var
            page = helper.getPage(this.request),
            articles = await getAllArticles(page);
        ctx.rest({
            page: page,
            articles: articles
        });
    },

    'POST /api/articles': async (ctx, next) => {
        /**
         * Create a new article.
         * 
         * @name Create Article
         * @param {string} category_id: Id of the category that article belongs to.
         * @param {string} name: Name of the article.
         * @param {string} description: Description of the article.
         * @param {string} content: Content of the article.
         * @param {string} [tags]: Tags of the article, seperated by ','.
         * @param {string} [publish_at]: Publish time of the article with format 'yyyy-MM-dd HH:mm:ss', default to current time.
         * @param {image} [image]: Base64 encoded image to upload as cover image.
         * @return {object} The created article object.
         * @error {parameter:invalid} If some parameter is invalid.
         * @error {permission:denied} If current user has no permission.
         */
        ctx.checkPermission(constants.role.EDITOR);
        ctx.validate('createArticle');
        var
            text,
            article,
            attachment,
            article_id = nextId(),
            content_id = nextId(),
            data = this.request.body;
        // check category id:
        await categoryApi.getCategory(data.category_id);

        attachment = await attachmentApi.createAttachment(
            ctx.state.__user__.id,
            data.name.trim(),
            data.description.trim(),
            new Buffer(data.image, 'base64'),
            null,
            true);

        text = await Text.create({
            id: content_id,
            ref_id: article_id,
            value: data.content
        });

        article = await Article.create({
            id: article_id,
            user_id: this.request.user.id,
            user_name: this.request.user.name,
            category_id: data.category_id,
            cover_id: attachment.id,
            content_id: content_id,
            name: data.name.trim(),
            description: data.description.trim(),
            tags: helper.formatTags(data.tags),
            publish_at: (data.publish_at === undefined ? Date.now() : data.publish_at)
        });

        article.content = data.content;
        indexArticle(article);

        this.body = article;
    },

    'POST /api/articles/:id': async (ctx, next) => {
        /**
         * Update an exist article.
         * 
         * @name Update Article
         * @param {string} id: Id of the article.
         * @param {string} [category_id]: Id of the category that article belongs to.
         * @param {string} [name]: Name of the article.
         * @param {string} [description]: Description of the article.
         * @param {string} [content]: Content of the article.
         * @param {string} [tags]: Tags of the article, seperated by ','.
         * @param {string} [publish_at]: Publish time of the article with format 'yyyy-MM-dd HH:mm:ss'.
         * @return {object} The updated article object.
         * @error {resource:notfound} Article was not found by id.
         * @error {parameter:invalid} If some parameter is invalid.
         * @error {permission:denied} If current user has no permission.
         */
        ctx.checkPermission(constants.role.EDITOR);
        ctx.validate('updateArticle');
        var
            user = ctx.state.__user__,
            article,
            props = {},
            text,
            attachment,
            data = ctx.request.body;

        article = await getArticle(id);
        if (user.role !== constants.role.ADMIN && user.id !== article.user_id) {
            throw api.notAllowed('Permission denied.');
        }
        if (data.category_id) {
            await categoryApi.getCategory(data.category_id);
            props.category_id = data.category_id;
        }
        if (data.name) {
            props.name = data.name.trim();
        }
        if (data.description) {
            props.description = data.description.trim();
        }
        if (data.tags) {
            props.tags = helper.formatTags(data.tags);
        }
        if (data.publish_at !== undefined) {
            props.publish_at = data.publish_at;
        }
        if (data.image) {
            // check image:
            attachment = await attachmentApi.createAttachment(
                user.id,
                article.name,
                article.description,
                new Buffer(data.image, 'base64'),
                null,
                true);
            props.cover_id = attachment.id;
        }
        if (data.content) {
            text = await Text.create({
                ref_id: article.id,
                value: data.content
            });
            props.content_id = text.id;
            article.content = data.content;
        }
        if (Object.getOwnPropertyNames(props).length > 0) {
            await article.update(props);
        }
        if (!article.content) {
            text = await Text.findById(article.content_id);
            article.content = text.value;
        }
        ctx.rest(article);
    },

    'POST /api/articles/:id/delete': async (ctx, next) => {
        /**
         * Delete an article.
         * 
         * @name Delete Article
         * @param {string} id: Id of the article.
         * @return {object} Object contains deleted id.
         * @error {resource:notfound} Article not found by id.
         * @error {permission:denied} If current user has no permission.
         */
        ctx.checkPermission(constants.role.EDITOR);
        var
            user = this.request.user,
            article = await getArticle(id);
        if (user.role !== constants.role.ADMIN && user.id !== article.user_id) {
            throw api.notAllowed('Permission denied.');
        }
        await article.destroy();
        await Text.destroy({
            where: {
                'ref_id': id
            }
        });
        ctx.rest({ 'id': id });
    }
};
