{{- define "boushun.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "boushun.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "boushun.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}
{{- end }}

{{- define "boushun.rbacName" -}}
{{- $base := printf "%s-%s" (include "boushun.fullname" .) .Release.Namespace -}}
{{- printf "%s-%s" ($base | trunc 54 | trimSuffix "-") ($base | sha256sum | trunc 8) -}}
{{- end }}

{{- define "boushun.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "boushun.labels" -}}
helm.sh/chart: {{ include "boushun.chart" . }}
{{ include "boushun.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "boushun.selectorLabels" -}}
app.kubernetes.io/name: {{ include "boushun.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "boushun.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "boushun.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- required "serviceAccount.name is required when serviceAccount.create is false" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
