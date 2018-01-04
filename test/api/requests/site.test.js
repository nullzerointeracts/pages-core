const crypto = require('crypto');
const expect = require('chai').expect;
const nock = require('nock');
const request = require('supertest');
const sinon = require('sinon');

const app = require('../../../app');
const factory = require('../support/factory');
const githubAPINocks = require('../support/githubAPINocks');
const { authenticatedSession, unauthenticatedSession } = require('../support/session');
const validateAgainstJSONSchema = require('../support/validateAgainstJSONSchema');
const csrfToken = require('../support/csrfToken');

const { Build, Site, User, UserAction } = require('../../../api/models');
const S3SiteRemover = require('../../../api/services/S3SiteRemover');
const siteErrors = require('../../../api/responses/siteErrors');

const authErrorMessage = 'You are not permitted to perform this action. Are you sure you are logged in?';

describe('Site API', () => {
  const siteResponseExpectations = (response, site) => {
    expect(response.owner).to.equal(site.owner);
    expect(response.repository).to.equal(site.repository);
    expect(response.engine).to.equal(site.engine);
    expect(response.defaultBranch).to.equal(site.defaultBranch);
    expect(response.viewLink).to.be.a('string');
  };

  describe('GET /v0/site', () => {
    it('should require authentication', (done) => {
      factory.build().then(() => request(app)
          .get('/v0/site')
          .expect(403))
          .then((response) => {
            validateAgainstJSONSchema('GET', '/site', 403, response.body);
            expect(response.body.message).to.equal(authErrorMessage);
            done();
          })
          .catch(done);
    });

    it('should render a list of sites associated with the user', (done) => {
      let user;
      let sites;
      let response;

      factory.user().then((model) => {
        user = model;
        const sitePromises = Array(3).fill(0).map(() => factory.site({ users: [user.id] }));
        return Promise.all(sitePromises);
      }).then((models) => {
        sites = models;
        return authenticatedSession(user);
      }).then(cookie => request(app)
          .get('/v0/site')
          .set('Cookie', cookie)
          .expect(200))
          .then((resp) => {
            response = resp;

            validateAgainstJSONSchema('GET', '/site', 200, response.body);

            expect(response.body).to.be.a('array');
            expect(response.body).to.have.length(3);

            return Promise.all(sites.map(site => Site.findById(site.id, { include: [User] })));
          })
          .then((foundSites) => {
            foundSites.forEach((site) => {
              const responseSite = response.body.find(candidate => candidate.id === site.id);
              expect(responseSite).not.to.be.undefined;
              siteResponseExpectations(responseSite, site);
            });
            done();
          })
          .catch(done);
    });

    it('should not render any sites not associated with the user', (done) => {
      const sitePromises = Array(3).fill(0).map(() => factory.site());

      Promise.all(sitePromises).then((site) => {
        expect(site).to.have.length(3);
        return authenticatedSession(factory.user());
      }).then(cookie => request(app)
          .get('/v0/site')
          .set('Cookie', cookie)
          .expect(200))
          .then((response) => {
            validateAgainstJSONSchema('GET', '/site', 200, response.body);
            expect(response.body).to.be.a('array');
            expect(response.body).to.be.empty;
            done();
          })
          .catch(done);
    });
  });

  describe('GET /v0/site/:id', () => {
    it('should require authentication', (done) => {
      factory.site().then(site => request(app)
          .get(`/v0/site/${site.id}`)
          .expect(403))
          .then((response) => {
            validateAgainstJSONSchema('GET', '/site/{id}', 403, response.body);
            expect(response.body.message).to.equal(authErrorMessage);
            done();
          })
          .catch(done);
    });

    it('should render a JSON representation of the site', (done) => {
      let site;

      factory.site()
        .then(s => Site.findById(s.id, { include: [User] }))
        .then((model) => {
          site = model;
          return authenticatedSession(site.Users[0]);
        })
        .then(cookie => request(app)
          .get(`/v0/site/${site.id}`)
          .set('Cookie', cookie)
          .expect(200)
        )
        .then((response) => {
          validateAgainstJSONSchema('GET', '/site/{id}', 200, response.body);
          siteResponseExpectations(response.body, site);
          done();
        })
        .catch(done);
    });

    it('should respond with a 403 if the user is not associated with the site', (done) => {
      let site;

      factory.site().then((model) => {
        site = model;
        return authenticatedSession(factory.user());
      }).then(cookie => request(app)
          .get(`/v0/site/${site.id}`)
          .set('Cookie', cookie)
          .expect(403))
          .then((response) => {
            validateAgainstJSONSchema('GET', '/site/{id}', 403, response.body);
            done();
          })
          .catch(done);
    });
  });

  describe('POST /v0/site', () => {
    beforeEach(() => {
      nock.cleanAll();
      githubAPINocks.repo();
      githubAPINocks.createRepoForOrg();
      githubAPINocks.webhook();
    });

    afterEach(() => {
      nock.cleanAll();
    });

    it('should require a valid csrf token', (done) => {
      authenticatedSession().then(cookie => request(app)
        .post('/v0/site')
        .set('x-csrf-token', 'bad-token')
        .send({
          owner: 'partner-org',
          repository: 'partner-site',
          defaultBranch: 'master',
          engine: 'jekyll',
        })
        .set('Cookie', cookie)
        .expect(403)
      )
      .then((response) => {
        validateAgainstJSONSchema('POST', '/site', 403, response.body);
        expect(response.body.message).to.equal('Invalid CSRF token');
        done();
      })
      .catch(done);
    });

    it('should require authentication', (done) => {
      unauthenticatedSession()
        .then((cookie) => {
          const newSiteRequest = request(app)
            .post('/v0/site')
            .set('x-csrf-token', csrfToken.getToken())
            .send({
              owner: 'partner-org',
              repository: 'partner-site',
              defaultBranch: 'master',
              engine: 'jekyll',
            })
            .set('Cookie', cookie)
            .expect(403);

          return newSiteRequest;
        })
        .then((response) => {
          validateAgainstJSONSchema('POST', '/site', 403, response.body);
          expect(response.body.message).to.equal(authErrorMessage);
          done();
        })
        .catch(done);
    });

    it('should create a new site from an existing repository', (done) => {
      const siteOwner = crypto.randomBytes(3).toString('hex');
      const siteRepository = crypto.randomBytes(3).toString('hex');

      authenticatedSession().then(cookie => request(app)
          .post('/v0/site')
          .set('x-csrf-token', csrfToken.getToken())
          .send({
            owner: siteOwner,
            repository: siteRepository,
            defaultBranch: 'master',
            engine: 'jekyll',
          })
          .set('Cookie', cookie)
          .expect(200)).then((response) => {
            validateAgainstJSONSchema('POST', '/site', 200, response.body);
            return Site.findOne({
              where: {
                owner: siteOwner,
                repository: siteRepository,
              },
            });
          })
          .then((site) => {
            expect(site).to.not.be.undefined;
            done();
          })
          .catch(done);
    });

    it('should create a new repo and site from a template', (done) => {
      const siteOwner = crypto.randomBytes(3).toString('hex');
      const siteRepository = crypto.randomBytes(3).toString('hex');

      nock.cleanAll();
      githubAPINocks.repo();
      githubAPINocks.webhook();

      const createRepoNock = githubAPINocks.createRepoForOrg({
        org: siteOwner,
        repo: siteRepository,
      });

      authenticatedSession().then(cookie => request(app)
          .post('/v0/site')
          .set('x-csrf-token', csrfToken.getToken())
          .send({
            owner: siteOwner,
            repository: siteRepository,
            defaultBranch: 'master',
            engine: 'jekyll',
            template: 'team',
          })
          .set('Cookie', cookie)
          .expect(200))
          .then((response) => {
            validateAgainstJSONSchema('POST', '/site', 200, response.body);
            return Site.findOne({
              where: {
                owner: siteOwner,
                repository: siteRepository,
              },
            });
          })
          .then((site) => {
            expect(site).to.not.be.undefined;
            expect(createRepoNock.isDone()).to.equal(true);
            done();
          })
          .catch(done);
    });

    it('should respond with a 400 if no user or repository is specified', (done) => {
      authenticatedSession().then(cookie => request(app)
          .post('/v0/site')
          .set('x-csrf-token', csrfToken.getToken())
          .send({
            defaultBranch: 'master',
            engine: 'jekyll',
            template: 'team',
          })
          .set('Cookie', cookie)
          .expect(400)).then((response) => {
            validateAgainstJSONSchema('POST', '/site', 400, response.body);
            done();
          }).catch(done);
    });

    it('should respond with a 400 if the site already exists', (done) => {
      const userPromise = factory.user();

      Promise.props({
        user: factory.user(),
        site: factory.site(),
        cookie: authenticatedSession(userPromise),
      }).then(({ site, cookie }) => request(app)
          .post('/v0/site')
          .set('x-csrf-token', csrfToken.getToken())
          .send({
            owner: site.owner,
            repository: site.repository,
            defaultBranch: 'master',
            engine: 'jekyll',
          })
          .set('Cookie', cookie)
          .expect(400)).then((response) => {
            validateAgainstJSONSchema('POST', '/site', 400, response.body);
            expect(response.body.message).to.equal('This site has already been added to Federalist');
            done();
          }).catch(done);
    });

    it('should respond with a 400 if the user does not have admin access to the repository', (done) => {
      const siteOwner = crypto.randomBytes(3).toString('hex');
      const siteRepository = crypto.randomBytes(3).toString('hex');

      nock.cleanAll();
      githubAPINocks.repo({
        owner: siteOwner,
        repository: siteRepository,
        response: [200, {
          permissions: { admin: false, push: false },
        }],
      });
      githubAPINocks.webhook();

      authenticatedSession().then(cookie => request(app)
          .post('/v0/site')
          .set('x-csrf-token', csrfToken.getToken())
          .send({
            owner: siteOwner,
            repository: siteRepository,
            defaultBranch: 'master',
            engine: 'jekyll',
          })
          .set('Cookie', cookie)
          .expect(400)).then((response) => {
            validateAgainstJSONSchema('POST', '/site', 400, response.body);
            expect(response.body.message).to.equal('You do not have admin access to this repository');
            done();
          }).catch(done);
    });

    it('should respond with a 400 if a webhook cannot be created', (done) => {
      const siteOwner = crypto.randomBytes(3).toString('hex');
      const siteRepository = crypto.randomBytes(3).toString('hex');

      nock.cleanAll();
      githubAPINocks.repo();
      githubAPINocks.webhook({
        owner: siteOwner,
        repo: siteRepository,
        response: [404, {
          message: 'Not Found',
        }],
      });

      authenticatedSession().then(cookie => request(app)
        .post('/v0/site')
        .set('x-csrf-token', csrfToken.getToken())
        .send({
          owner: siteOwner,
          repository: siteRepository,
          defaultBranch: 'master',
          engine: 'jekyll',
        })
        .set('Cookie', cookie)
        .expect(400)).then((response) => {
          validateAgainstJSONSchema('POST', '/site', 400, response.body);
          expect(response.body.message).to.equal('You do not have admin access to this repository');
          done();
        }).catch(done);
    });
  });

  describe('POST /v0/site/user', () => {
    beforeEach(() => {
      nock.cleanAll();
      githubAPINocks.repo();
    });

    it('should require a valid csrf token', (done) => {
      authenticatedSession().then(cookie => request(app)
        .post('/v0/site/user')
        .set('x-csrf-token', 'bad-token')
        .send({
          owner: 'partner-org',
          repository: 'partner-site',
        })
        .set('Cookie', cookie)
        .expect(403)
      )
      .then((response) => {
        validateAgainstJSONSchema('POST', '/site/user', 403, response.body);
        expect(response.body.message).to.equal('Invalid CSRF token');
        done();
      })
      .catch(done);
    });

    it('should require authentication', (done) => {
      unauthenticatedSession()
        .then((cookie) => {
          const newSiteRequest = request(app)
            .post('/v0/site/user')
            .set('x-csrf-token', csrfToken.getToken())
            .send({
              owner: 'partner-org',
              repository: 'partner-site',
            })
            .set('Cookie', cookie)
            .expect(403);

          return newSiteRequest;
        })
        .then((response) => {
          validateAgainstJSONSchema('POST', '/site/user', 403, response.body);
          expect(response.body.message).to.equal(authErrorMessage);
          done();
        })
        .catch(done);
    });

    it('should add the user to the site', (done) => {
      const userPromise = factory.user();
      let user;
      let site;

      Promise.props({
        user: userPromise,
        site: factory.site(),
        cookie: authenticatedSession(userPromise),
      })
        .then((models) => {
          user = models.user;
          site = models.site;

          return request(app)
            .post('/v0/site/user')
            .set('x-csrf-token', csrfToken.getToken())
            .set('Cookie', models.cookie)
            .send({
              owner: site.owner,
              repository: site.repository,
            })
            .expect(200);
        })
        .then((response) => {
          validateAgainstJSONSchema('POST', '/site/user', 200, response.body);
          return Site.findById(site.id, { include: [User] });
        })
        .then((fetchedSite) => {
          expect(fetchedSite.Users).to.be.an('array');
          const userIDs = fetchedSite.Users.map(u => u.id);
          expect(userIDs).to.include(user.id);
          done();
        })
        .catch(done);
    });

    it('should respond with a 400 if no user or repository is specified', (done) => {
      authenticatedSession()
        .then(cookie =>
          request(app)
            .post('/v0/site/user')
            .set('x-csrf-token', csrfToken.getToken())
            .set('Cookie', cookie)
            .send({})
            .expect(400)
        )
        .then((response) => {
          validateAgainstJSONSchema('POST', '/site/user', 400, response.body);
          done();
        }).catch(done);
    });

    it('should respond with a 400 if the user has already added the site', (done) => {
      const userPromise = factory.user();

      Promise.props({
        site: factory.site({ users: Promise.all([userPromise]) }),
        cookie: authenticatedSession(userPromise),
      })
        .then(({ site, cookie }) =>
          request(app)
            .post('/v0/site/user')
            .set('x-csrf-token', csrfToken.getToken())
            .set('Cookie', cookie)
            .send({
              owner: site.owner,
              repository: site.repository,
            })
            .expect(400)
        )
        .then((response) => {
          validateAgainstJSONSchema('POST', '/site/user', 400, response.body);
          expect(response.body.message).to.eq("You've already added this site to Federalist");
          done();
        })
        .catch(done);
    });

    it('should respond with a 400 if the user does not have write access to repository', (done) => {
      const siteOwner = crypto.randomBytes(3).toString('hex');
      const siteRepository = crypto.randomBytes(3).toString('hex');

      nock.cleanAll();
      githubAPINocks.repo({
        owner: siteOwner,
        repository: siteRepository,
        response: [200, {
          permissions: { admin: false, push: false },
        }],
      });
      githubAPINocks.webhook();

      Promise.props({
        cookie: authenticatedSession(),
        site: factory.site({ owner: siteOwner, repository: siteRepository }),
      }).then(({ cookie, site }) =>
        request(app)
          .post('/v0/site/user')
          .set('x-csrf-token', csrfToken.getToken())
          .set('Cookie', cookie)
          .send({
            owner: site.owner,
            repository: site.repository,
          })
          .expect(400)
      ).then((response) => {
        validateAgainstJSONSchema('POST', '/site/user', 400, response.body);
        expect(response.body.message).to.eq('You do not have write access to this repository');
        done();
      })
      .catch(done);
    });

    it('should respond with a 404 if the site does not exist', (done) => {
      authenticatedSession().then(cookie =>
        request(app)
          .post('/v0/site/user')
          .set('x-csrf-token', csrfToken.getToken())
          .set('Cookie', cookie)
          .send({
            owner: 'this-is',
            repository: 'not-real',
          })
          .expect(404)
      ).then((response) => {
        validateAgainstJSONSchema('POST', '/site/user', 404, response.body);
        expect(response.body.message).to.eq('The site you are trying to add does not exist');
        done();
      })
      .catch(done);
    });
  });

  describe('DELETE /v0/site/:site_id/user/:user_id', () => {
    const path = '/site/{site_id}/user/{user_id}';
    const requestPath = (siteId, userId) => `/v0/site/${siteId}/user/${userId}`;

    it('should require a valid csrf token', (done) => {
      authenticatedSession().then(cookie => request(app)
        .delete(requestPath(1, 1))
        .set('x-csrf-token', 'bad-token')
        .set('Cookie', cookie)
        .expect(403)
      )
      .then((response) => {
        validateAgainstJSONSchema('DELETE', path, 403, response.body);
        expect(response.body.message).to.equal('Invalid CSRF token');
        done();
      })
      .catch(done);
    });

    it('should require authentication', (done) => {
      unauthenticatedSession()
        .then((cookie) => {
          const newSiteRequest = request(app)
            .delete(requestPath(1, 1))
            .set('x-csrf-token', csrfToken.getToken())
            .set('Cookie', cookie)
            .expect(403);
          return newSiteRequest;
        })
        .then((response) => {
          validateAgainstJSONSchema('DELETE', path, 403, response.body);
          expect(response.body.message).to.equal(authErrorMessage);
          done();
        })
        .catch(done);
    });

    it('should respond with a 400 if siteId or userId are not numbers', (done) => {
      const userPromise = factory.user();

      Promise.props({
        user: userPromise,
        site: factory.site(),
        cookie: authenticatedSession(userPromise),
      })
      .then(models =>
        request(app).delete(requestPath('a-site', 'a-user'))
          .set('x-csrf-token', csrfToken.getToken())
          .set('Cookie', models.cookie)
          .expect(400)
      ).then((response) => {
        validateAgainstJSONSchema('DELETE', path, 400, response.body);
        expect(response.body.message).to.equal('Bad Request');
        done();
      })
      .catch(done);
    });

    it('should return a 404 if the site cannot be found', (done) => {
      const userPromise = factory.user();

      Promise.props({
        user: userPromise,
        site: factory.site(),
        cookie: authenticatedSession(userPromise),
      })
      .then(models =>
        request(app).delete(requestPath(1000, models.user.id))
          .set('x-csrf-token', csrfToken.getToken())
          .set('Cookie', models.cookie)
          .expect(404)
      ).then((response) => {
        validateAgainstJSONSchema('DELETE', path, 404, response.body);
        expect(response.body.message).to.equal('Not found');
        done();
      })
      .catch(done);
    });

    it('should remove the user from the site', (done) => {
      const mike = factory.user({ username: 'mike' });
      const jane = factory.user({ username: 'jane' });
      let currentSite;
      let activeUser;

      Promise.props({
        user: jane,
        site: factory.site({ users: Promise.all([mike, jane]) }),
        cookie: authenticatedSession(jane),
      }).then(({ user, site, cookie }) => {
        currentSite = site;
        activeUser = user;

        return request(app).delete(requestPath(site.id, user.id))
          .set('x-csrf-token', csrfToken.getToken())
          .set('Cookie', cookie)
          .expect(200);
      }).then((response) => {
        validateAgainstJSONSchema('DELETE', path, 200, response.body);
        return Site.withUsers(currentSite.id);
      }).then((fetchedSite) => {
        expect(fetchedSite.Users).to.be.an('array');
        expect(fetchedSite.Users.length).to.equal(1);
        return UserAction.find({ where: {
          userId: activeUser.id,
          targetId: activeUser.id,
        } });
      })
      .then((action) => {
        expect(action).to.exist;
        expect(action.get('targetType')).to.equal('user');
        done();
      })
      .catch(done);
    });

    it('should allow the owner to remove a user from the site', (done) => {
      const username = 'b-user';
      const userPromise = factory.user({ username });
      const anotherUser = factory.user();
      const siteProps = {
        owner: username,
        users: Promise.all([userPromise, anotherUser]),
      };

      let currentSite;

      nock.cleanAll();

      Promise.props({
        user: userPromise,
        site: factory.site(siteProps),
        cookie: authenticatedSession(userPromise),
        anotherUser,
      })
      .then((models) => {
        currentSite = models.site;

        githubAPINocks.repo({
          owner: username,
          repository: models.site.repo,
          response: [200, {
            permissions: { admin: true, push: true },
          }],
        });

        return request(app).delete(requestPath(models.site.id, models.anotherUser.id))
          .set('x-csrf-token', csrfToken.getToken())
          .set('Cookie', models.cookie)
          .expect(200);
      }).then((response) => {
        validateAgainstJSONSchema('DELETE', path, 200, response.body);
        return Site.withUsers(currentSite.id);
      }).then((fetchedSite) => {
        expect(fetchedSite.Users).to.be.an('array');
        expect(fetchedSite.Users.length).to.equal(1);
        done();
      })
      .catch(done);
    });

    it('should respond with a 400 when deleting the final user', (done) => {
      const userPromise = factory.user();

      Promise.props({
        user: userPromise,
        site: factory.site({ users: Promise.all([userPromise]) }),
        cookie: authenticatedSession(userPromise),
      })
      .then(({ user, site, cookie }) =>
        request(app).delete(requestPath(site.id, user.id))
          .set('x-csrf-token', csrfToken.getToken())
          .set('Cookie', cookie)
          .expect(400)
      ).then((response) => {
        validateAgainstJSONSchema('DELETE', path, 400, response.body);
        expect(response.body.message).to.equal(siteErrors.USER_REQUIRED);
        done();
      })
      .catch(done);
    });

    it('should respond with a 404 when the user to delete is not found', (done) => {
      const userPromise = factory.user();
      const otherUser = factory.user();

      nock.cleanAll();

      Promise.props({
        site: factory.site({ users: Promise.all([userPromise, otherUser]) }),
        cookie: authenticatedSession(userPromise),
      })
      .then((models) => {
        githubAPINocks.repo({
          owner: 'james',
          repository: models.site.repo,
          response: [200, {
            permissions: { admin: true, push: true },
          }],
        });

        return request(app).delete(requestPath(models.site.id, 100000))
          .set('x-csrf-token', csrfToken.getToken())
          .set('Cookie', models.cookie)
          .expect(404);
      }).then((response) => {
        validateAgainstJSONSchema('DELETE', path, 404, response.body);
        expect(response.body.message).to.equal(siteErrors.NO_ASSOCIATED_USER);
        done();
      })
      .catch(done);
    });

    it('should respond with a 400 when any user attempts to remove the owner', (done) => {
      const ownerName = 'owner';
      const ownerUser = factory.user({ username: ownerName });
      const normalUser = factory.user({ username: 'not-owner' });

      const siteProps = {
        owner: ownerName,
        users: Promise.all([ownerUser, normalUser]),
      };

      nock.cleanAll();

      Promise.props({
        user: ownerUser,
        site: factory.site(siteProps),
        cookie: authenticatedSession(normalUser),
      })
      .then(({ user, site, cookie }) => {
        githubAPINocks.repo({
          owner: ownerName,
          repository: site.repo,
          response: [200, {
            permissions: { admin: true, push: true },
          }],
        });

        return request(app).delete(requestPath(site.id, user.id))
          .set('x-csrf-token', csrfToken.getToken())
          .set('Cookie', cookie)
          .expect(400);
      }).then((response) => {
        validateAgainstJSONSchema('DELETE', path, 400, response.body);
        expect(response.body.message).to.equal(siteErrors.OWNER_REMOVE);
        done();
      })
      .catch(done);
    });

    it('should respond with a 400 when the site owner attempts to remove themselves', (done) => {
      const username = 'a-user';
      const userPromise = factory.user({ username });
      const anotherUser = factory.user();
      const siteProps = {
        owner: username,
        users: Promise.all([userPromise, anotherUser]),
      };

      nock.cleanAll();

      Promise.props({
        user: userPromise,
        site: factory.site(siteProps),
        cookie: authenticatedSession(userPromise),
      })
      .then(({ user, site, cookie }) => {
        githubAPINocks.repo({
          owner: username,
          repository: site.repo,
          response: [200, {
            permissions: { admin: true, push: true },
          }],
        });

        return request(app).delete(`/v0/site/${site.id}/user/${user.id}`)
          .set('x-csrf-token', csrfToken.getToken())
          .set('Cookie', cookie)
          .expect(400);
      }).then((response) => {
        validateAgainstJSONSchema('DELETE', path, 400, response.body);
        expect(response.body.message).to.equal(siteErrors.OWNER_REMOVE);
        done();
      })
      .catch(done);
    });

    it('should respond with a 400 if the user does not have admin access', (done) => {
      const username = 'jane';
      const userA = factory.user();
      const userB = factory.user();
      const repo = 'whatever';
      const siteProps = {
        owner: username,
        repository: repo,
        users: Promise.all([userA, userB]),
      };

      nock.cleanAll();

      Promise.props({
        user: userA,
        site: factory.site(siteProps),
        cookie: authenticatedSession(userA),
      }).then(({ user, site, cookie }) => {
        githubAPINocks.repo({
          owner: site.username,
          repository: site.repo,
          response: [200, {
            permissions: { admin: false, push: false },
          }],
        });

        return request(app).delete(`/v0/site/${site.id}/user/${user.id}`)
          .set('x-csrf-token', csrfToken.getToken())
          .set('Cookie', cookie)
          .expect(400);
      }).then((response) => {
        validateAgainstJSONSchema('DELETE', path, 400, response.body);
        expect(response.body.message).to.equal(siteErrors.WRITE_ACCESS_REQUIRED);
        done();
      })
      .catch(done);
    });
  });

  describe('DELETE /v0/site/:id', () => {
    beforeEach(() => {
      sinon.stub(S3SiteRemover, 'removeSite', () => Promise.resolve());
    });

    afterEach(() => {
      S3SiteRemover.removeSite.restore();
    });

    it('should require authentication', (done) => {
      let site;

      factory.site()
        .then((model) => {
          site = model;
          return unauthenticatedSession();
        })
        .then(cookie => request(app)
          .delete(`/v0/site/${site.id}`)
          .set('x-csrf-token', csrfToken.getToken())
          .set('Cookie', cookie)
          .expect(403)
        )
        .then((response) => {
          validateAgainstJSONSchema('DELETE', '/site/{id}', 403, response.body);
          expect(response.body.message).to.equal(authErrorMessage);
          done();
        })
        .catch(done);
    });

    it('should require a valid csrf token', (done) => {
      let site;

      factory.site()
        .then((model) => {
          site = model;
          return authenticatedSession();
        })
        .then(cookie => request(app)
          .delete(`/v0/site/${site.id}`)
          .set('x-csrf-token', 'bad-token')
          .set('Cookie', cookie)
          .expect(403)
        )
        .then((response) => {
          validateAgainstJSONSchema('PUT', '/site/{id}', 403, response.body);
          expect(response.body.message).to.equal('Invalid CSRF token');
          done();
        })
        .catch(done);
    });


    it('should allow a user to delete a site associated with their account', (done) => {
      let site;

      factory.site()
        .then(s => Site.findById(s.id, { include: [User] }))
        .then((model) => {
          site = model;
          return authenticatedSession(site.Users[0]);
        })
        .then(cookie => request(app)
          .delete(`/v0/site/${site.id}`)
          .set('x-csrf-token', csrfToken.getToken())
          .set('Cookie', cookie)
          .expect(200)
        )
        .then((response) => {
          validateAgainstJSONSchema('DELETE', '/site/{id}', 200, response.body);
          siteResponseExpectations(response.body, site);
          return Site.findAll({ where: { id: site.id } });
        })
        .then((sites) => {
          expect(sites).to.be.empty;
          done();
        })
        .catch(done);
    });

    it('should not allow a user to delete a site not associated with their account', (done) => {
      let site;

      factory.site()
        .then(s => Site.findById(s.id))
        .then((model) => {
          site = model;
          return authenticatedSession(factory.user());
        })
        .then(cookie => request(app)
          .delete(`/v0/site/${site.id}`)
          .set('x-csrf-token', csrfToken.getToken())
          .set('Cookie', cookie)
          .expect(403)
        )
        .then((response) => {
          validateAgainstJSONSchema('DELETE', '/site/{id}', 403, response.body);
          return Site.findAll({ where: { id: site.id } });
        })
        .then((sites) => {
          expect(sites).not.to.be.empty;
          done();
        })
        .catch(done);
    });

    it("should remove all of the site's data from S3", (done) => {
      let site;
      const userPromise = factory.user();
      const sitePromise = factory.site({ users: Promise.all([userPromise]) });
      const sessionPromise = authenticatedSession(userPromise);

      Promise.props({
        user: userPromise,
        site: sitePromise,
        cookie: sessionPromise,
      }).then((results) => {
        site = results.site;
        S3SiteRemover.removeSite.restore();
        sinon.stub(S3SiteRemover, 'removeSite', (calledSite) => {
          expect(calledSite.id).to.equal(site.id);
          return Promise.resolve();
        });

        return request(app)
          .delete(`/v0/site/${site.id}`)
          .set('x-csrf-token', csrfToken.getToken())
          .set('Cookie', results.cookie)
          .expect(200);
      })
      .then(() => {
        expect(S3SiteRemover.removeSite.calledOnce).to.equal(true);
        done();
      })
      .catch(done);
    });
  });

  describe('PUT /v0/site/:id', () => {
    it('should require authentication', (done) => {
      let site;

      factory.site()
        .then((model) => {
          site = model;
          return unauthenticatedSession();
        })
        .then(cookie => request(app)
          .put(`/v0/site/${site.id}`)
          .set('x-csrf-token', csrfToken.getToken())
          .send({
            defaultBranch: 'master',
          })
          .set('Cookie', cookie)
          .expect(403)
        )
        .then((response) => {
          validateAgainstJSONSchema('PUT', '/site/{id}', 403, response.body);
          expect(response.body.message).to.equal(authErrorMessage);
          done();
        })
        .catch(done);
    });

    it('should require a valid csrf token', (done) => {
      let site;

      factory.site()
        .then((model) => {
          site = model;
          return authenticatedSession();
        })
        .then(cookie => request(app)
          .put(`/v0/site/${site.id}`)
          .set('x-csrf-token', 'bad-token')
          .send({
            defaultBranch: 'master',
          })
          .set('Cookie', cookie)
          .expect(403)
        )
        .then((response) => {
          validateAgainstJSONSchema('PUT', '/site/{id}', 403, response.body);
          expect(response.body.message).to.equal('Invalid CSRF token');
          done();
        })
        .catch(done);
    });

    it('should allow a user to update a site associated with their account', (done) => {
      let site;
      let response;

      factory.site({ config: 'old-config', demoConfig: 'old-demo-config', previewConfig: 'old-preview-config' })
        .then(s => Site.findById(s.id, { include: [User] }))
        .then((model) => {
          site = model;
          return authenticatedSession(site.Users[0]);
        })
        .then(cookie => request(app)
          .put(`/v0/site/${site.id}`)
          .set('x-csrf-token', csrfToken.getToken())
          .send({
            config: 'new-config',
            demoConfig: 'new-demo-config',
            previewConfig: 'new-preview-config',
          })
          .set('Cookie', cookie)
          .expect(200)
        )
        .then((resp) => {
          response = resp;
          return Site.findById(site.id, { include: [User] });
        })
        .then((foundSite) => {
          validateAgainstJSONSchema('PUT', '/site/{id}', 200, response.body);

          expect(response.body.config).to.equal('new-config');
          expect(foundSite.config).to.equal('new-config');
          expect(response.body.demoConfig).to.equal('new-demo-config');
          expect(foundSite.demoConfig).to.equal('new-demo-config');
          expect(response.body.previewConfig).to.equal('new-preview-config');
          expect(foundSite.previewConfig).to.equal('new-preview-config');
          siteResponseExpectations(response.body, foundSite);
          done();
        })
        .catch(done);
    });

    it('should not allow a user to update a site not associated with their account', (done) => {
      let siteModel;
      factory.site({ repository: 'old-repo-name' })
        .then(site => Site.findById(site.id))
        .then((model) => {
          siteModel = model;
          return authenticatedSession(factory.user());
        })
        .then(cookie => request(app)
            .put(`/v0/site/${siteModel.id}`)
            .set('x-csrf-token', csrfToken.getToken())
            .send({
              repository: 'new-repo-name',
            })
            .set('Cookie', cookie)
            .expect(403)
        )
        .then((response) => {
          validateAgainstJSONSchema('PUT', '/site/{id}', 403, response.body);
          return Site.findById(siteModel.id);
        })
        .then((site) => {
          expect(site).to.have.property('repository', 'old-repo-name');
          done();
        })
        .catch(done);
    });

    it('should trigger a rebuild of the site', (done) => {
      let siteModel;
      factory.site({ repository: 'old-repo-name' })
        .then(site => Site.findById(site.id, { include: [User, Build] }))
        .then((model) => {
          siteModel = model;
          expect(siteModel.Builds).to.have.length(0);
          return authenticatedSession(siteModel.Users[0]);
        })
        .then(cookie => request(app)
          .put(`/v0/site/${siteModel.id}`)
          .set('x-csrf-token', csrfToken.getToken())
          .send({
            repository: 'new-repo-name',
          })
          .set('Cookie', cookie)
          .expect(200)
        )
        .then(() => Site.findById(siteModel.id, { include: [User, Build] }))
        .then((site) => {
          expect(site.Builds).to.have.length(1);
          expect(site.Builds[0].branch).to.equal(site.defaultBranch);
          done();
        })
        .catch(done);
    });

    it('should trigger a rebuild of the demo branch if one is present', (done) => {
      let siteModel;
      factory.site({
        repository: 'old-repo-name',
        demoBranch: 'demo',
        demoDomain: 'https://demo.example.gov',
      })
      .then(site => Site.findById(site.id, { include: [User, Build] }))
      .then((model) => {
        siteModel = model;
        expect(siteModel.Builds).to.have.length(0);
        return authenticatedSession(siteModel.Users[0]);
      })
      .then(cookie => request(app)
        .put(`/v0/site/${siteModel.id}`)
        .set('x-csrf-token', csrfToken.getToken())
        .send({
          repository: 'new-repo-name',
        })
        .set('Cookie', cookie)
        .expect(200)
      )
      .then(() => Site.findById(siteModel.id, { include: [User, Build] }))
      .then((site) => {
        expect(site.Builds).to.have.length(2);
        const demoBuild = site.Builds.find(
          candidateBuild => candidateBuild.branch === site.demoBranch);
        expect(demoBuild).to.not.be.undefined;
        done();
      })
      .catch(done);
    });

    it('should update attributes when the value in the request body is an empty string', (done) => {
      let site;
      const userPromise = factory.user();
      const sitePromise = factory.site({
        users: Promise.all([userPromise]),
        config: 'old-config: true',
        domain: 'https://example.com',
      });
      const cookiePromise = authenticatedSession(userPromise);

      Promise.props({
        user: userPromise,
        site: sitePromise,
        cookie: cookiePromise,
      })
      .then((results) => {
        site = results.site;

        return request(app)
          .put(`/v0/site/${site.id}`)
          .set('x-csrf-token', csrfToken.getToken())
          .send({
            config: '',
            domain: '',
          })
          .set('Cookie', results.cookie)
          .expect(200);
      })
      .then((response) => {
        validateAgainstJSONSchema('PUT', '/site/{id}', 200, response.body);
        return Site.findById(site.id);
      })
      .then((foundSite) => {
        expect(foundSite.config).to.equal('');
        expect(foundSite.domain).to.equal('');
        done();
      })
      .catch(done);
    });

    it('should not override existing attributes if they are not present in the request body', (done) => {
      let site;
      const userPromise = factory.user();
      const sitePromise = factory.site({
        users: Promise.all([userPromise]),
        config: 'old-config: true',
        domain: 'https://example.com',
      });
      const cookiePromise = authenticatedSession(userPromise);

      Promise.props({
        user: userPromise,
        site: sitePromise,
        cookie: cookiePromise,
      })
      .then((results) => {
        site = results.site;

        return request(app)
          .put(`/v0/site/${site.id}`)
          .set('x-csrf-token', csrfToken.getToken())
          .send({
            config: 'new-config: true',
          })
          .set('Cookie', results.cookie)
          .expect(200);
      })
      .then((response) => {
        validateAgainstJSONSchema('PUT', '/site/{id}', 200, response.body);
        return Site.findById(site.id);
      })
      .then((foundSite) => {
        expect(foundSite.config).to.equal('new-config: true');
        expect(foundSite.domain).to.equal('https://example.com');
        done();
      })
      .catch(done);
    });
  });
});
