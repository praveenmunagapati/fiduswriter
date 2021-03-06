from django.conf.urls import include, url
from django.http import HttpResponse
from django.contrib import admin
from adminplus.sites import AdminSitePlus
from . import settings
from django.contrib.flatpages import views as flatpages_views
from document.views import index as document_index

from django.views.i18n import JavaScriptCatalog
from importlib import import_module

admin.site = AdminSitePlus()
admin.sites.site = admin.site
admin.autodiscover()

# Django URLs -- Notice that these are only consulted after the
# tornado_url_list found in base/servers/tornado_django_hybrid.py
urlpatterns = [
    url('^$', document_index, name='index'),
    url(
        '^robots\.txt$',
        lambda r: HttpResponse(
            "User-agent: *\nDisallow: /text/\nDisallow: /bibliography/",
            mimetype="text/plain"
        )
    ),

    # I18n manual language switcher
    url('^i18n/', include('django.conf.urls.i18n')),

    # I18n Javascript translations
    url(r'^jsi18n/$', JavaScriptCatalog.as_view(), name='javascript-catalog'),

    # Admin interface
    url('^admin/doc/', include('django.contrib.admindocs.urls')),
    url('^admin/', include(admin.site.urls)),

    # Account management
    url('^account/', include('user.urls')),

    # Terms and conditions
    url('^terms/$', flatpages_views.flatpage,
        {'url': '/terms/'}, name='terms'),

]

for app in settings.INSTALLED_APPS:
    try:
        _module = import_module('%s.urls' % app)
    except ImportError:
        pass
    else:
        app_name = app.rsplit('.', 1).pop()
        urlpatterns += [url('^%s/' % app_name, include('%s.urls' % app))]

if settings.DEBUG:
    from django.views.static import serve as static_serve
    urlpatterns += [
        url('^media/(?P<path>.*)$', static_serve, {
            'document_root': settings.MEDIA_ROOT,
        }),
    ]

if hasattr(settings, 'EXTRA_URLS'):
    for extra_url in settings.EXTRA_URLS:
        urlpatterns += [
            url(extra_url[0], include(extra_url[1])),
        ]
