# -*- coding: utf-8 -*-
"""
LAIS Python toolbox for ArcMap 10.x (also loads in ArcGIS Pro).

Add it in ArcCatalog/ArcMap: Catalog window > right-click a folder > Add Toolbox > LAIS.pyt.
Tools: Test connection, Export LAIS package, Sync to LAIS. See README.md for setup.
"""
import os
import sys

import arcpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lais_arcmap as lais  # noqa: E402


def _param(name, label, datatype, required=True, direction='Input'):
    p = arcpy.Parameter(name=name, displayName=label, datatype=datatype,
                        parameterType='Required' if required else 'Optional', direction=direction)
    return p


def _common():
    fc = _param('feature_class', 'Parcel polygons', 'GPFeatureLayer')
    case = _param('case_no', 'LAIS case number', 'GPString')
    county = _param('county_code', 'County code (two letters)', 'GPString')
    mapping = _param('field_mapping', 'Field mapping (target=SourceField;...)', 'GPString', required=False)
    mapping.value = ''
    return [fc, case, county, mapping]


def _messages_from(messages, manifest):
    messages.addMessage('Export %s: %d feature(s), EPSG:%s' % (manifest['export_id'], manifest['feature_count'], manifest['srid']))
    for w in manifest.get('warnings', []):
        messages.addWarningMessage(w)


class Toolbox(object):
    def __init__(self):
        self.label = 'LAIS'
        self.alias = 'lais'
        self.tools = [TestConnection, ExportPackage, SyncToLais]


class TestConnection(object):
    def __init__(self):
        self.label = 'Test connection'
        self.description = 'Checks the LAIS address and your sync token. Nothing is sent but the token.'
        self.canRunInBackground = False

    def getParameterInfo(self):
        url = _param('url', 'LAIS server address (blank: LAIS_URL)', 'GPString', required=False)
        return [url]

    def execute(self, parameters, messages):
        try:
            r = lais.ping(parameters[0].valueAsText or None)
            messages.addMessage('Connected as %s. Counties you can sync: %s' % (r['user'], ', '.join(c['code'] for c in r['counties']) or 'none'))
        except lais.AdapterError as e:
            messages.addErrorMessage(str(e))
            raise arcpy.ExecuteError


class ExportPackage(object):
    def __init__(self):
        self.label = 'Export LAIS package'
        self.description = ('Validates the layer (polygons, EPSG:4326 or 32629, mapped fields) and writes a LAIS package. '
                            'The CRS is never assigned or changed.')
        self.canRunInBackground = False

    def getParameterInfo(self):
        out = _param('out_folder', 'Output folder', 'DEFolder')
        return _common() + [out]

    def execute(self, parameters, messages):
        try:
            package, manifest = lais.export_package(parameters[0].valueAsText, parameters[1].valueAsText, parameters[2].valueAsText,
                                                    lais.parse_mapping(parameters[3].valueAsText), out_dir=parameters[4].valueAsText, arcpy=arcpy)
            _messages_from(messages, manifest)
            messages.addMessage('Package written: %s' % package)
        except lais.AdapterError as e:
            messages.addErrorMessage(str(e))
            raise arcpy.ExecuteError


class SyncToLais(object):
    def __init__(self):
        self.label = 'Sync to LAIS'
        self.description = ('Exports and uploads the layer as a new working version of the case. Sending the same data '
                            'again does not create a duplicate.')
        self.canRunInBackground = False

    def getParameterInfo(self):
        purpose = _param('purpose', 'Purpose / change note', 'GPString', required=False)
        url = _param('url', 'LAIS server address (blank: LAIS_URL)', 'GPString', required=False)
        return _common() + [purpose, url]

    def execute(self, parameters, messages):
        try:
            package, manifest, result = lais.sync(parameters[0].valueAsText, parameters[1].valueAsText, parameters[2].valueAsText,
                                                  lais.parse_mapping(parameters[3].valueAsText), purpose=parameters[4].valueAsText,
                                                  url=parameters[5].valueAsText or None, arcpy=arcpy)
            _messages_from(messages, manifest)
            if result.get('duplicate'):
                messages.addMessage('Already processed as job %s: nothing new was staged.' % result.get('job_no'))
            else:
                messages.addMessage('Job %s: %s (version %s)' % (result.get('job_no'), result.get('status'), result.get('version_no')))
                if result.get('status') == 'failed':
                    messages.addErrorMessage(result.get('error_summary') or 'The job failed; see LAIS > GIS > Jobs.')
                    raise arcpy.ExecuteError
        except lais.AdapterError as e:
            messages.addErrorMessage(str(e))
            raise arcpy.ExecuteError
